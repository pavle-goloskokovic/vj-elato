"""VJ Elato local server: static files with byte ranges, plus a video proxy with a cache.

usage: python serve.py [port] [folder] [--no-browser] [--cache-gb N] [--reserve-mb N] [--cache-dir DIR] [--no-cache] [--no-proxy]
                       [--yt-max 720|1080] [--no-adapt]
  default folder: the one this file is in (the portable copy on the stick)

Why a proxy: the browser may display a video from any host, but WebGL may only read
pixels from a same-origin or CORS-enabled source, and neither Destockd's CDN nor
archive.org's storage nodes send CORS headers. Served through this proxy the video is
same-origin, so the player can run it through the full effect chain.

  GET  /proxy?url=<encoded video url>   streams the video (Range requests are passed
                                         upstream); served from the cache once complete
  GET  /proxy/info                       {proxy, cache:{used, cap, count, ...}, fetchOnPlay}
  GET  /proxy/list                       cache entries (url -> file relative to the stick root)
  POST /proxy/settings  {"fetchOnPlay": bool}
  POST /proxy/clear
  GET  /proxy/resolve?url=<youtube url>  {id, title, duration, thumbnail} via yt-dlp, or {error}

YouTube: a watch URL given to /proxy is resolved with yt-dlp (yt-dlp.exe next to this file,
or on PATH) to a direct H.264 video stream, which is then proxied and cached like any other
URL, keyed by the video id so the short-lived stream address never creates duplicates.
The stream is video-only; the player is muted anyway. The rendition follows the link: the
server learns each host's throughput from its cache downloads (and a 2.5 s probe on the
first YouTube resolve) and picks the highest H.264 rendition up to --yt-max whose bitrate
is at most half of it; --no-adapt always takes the best. /proxy/info reports the speeds.

The cache lives in <stick root>/cache (the parent of the vj-elato folder), capped at
--cache-gb (default 2) and never eating into --reserve-mb (default 500) of free space.
With fetch-on-play, the first play of a stream also downloads the whole file in the
background; a file is listed as cached only once complete. Least recently used clips
are removed to make room. Only files this proxy wrote are ever deleted.
"""
import hashlib, json, os, re, shutil, ssl, subprocess, sys, threading, time, urllib.parse, urllib.request, webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
def opt(name, default):
    if name in sys.argv:
        i = sys.argv.index(name); return sys.argv[i + 1] if i + 1 < len(sys.argv) else default
    return default
ROOT = os.path.abspath(ARGS[1]) if len(ARGS) > 1 else os.path.dirname(os.path.abspath(__file__))
PORT = int(ARGS[0]) if ARGS else 8765
OPEN = "--no-browser" not in sys.argv
STICK = os.path.dirname(ROOT) if os.path.basename(ROOT).lower() == "vj-elato" else ROOT
CACHE_DIR = os.path.abspath(opt("--cache-dir", os.path.join(STICK, "cache")))
CACHE_CAP = int(float(opt("--cache-gb", "2")) * 1e9)
RESERVE = int(float(opt("--reserve-mb", "500")) * 1e6)
CACHE_ON = "--no-cache" not in sys.argv
PROXY_ON = "--no-proxy" not in sys.argv          # off = behave like plain static hosting (GitHub Pages)
UA = "vj-elato local proxy"
CHUNK = 256 * 1024

# ---------- upstream ----------
_ssl_ctx = None
def ssl_context():
    """Verified TLS; if the local certificate store is unusable (it is on some Windows
    machines) fall back to unverified with a warning, since this only fetches public video."""
    global _ssl_ctx
    if _ssl_ctx is None:
        try:
            ctx = ssl.create_default_context()
            ctx.load_default_certs()
            _ssl_ctx = ctx
        except Exception as e:
            print(f"  warning: TLS verification unavailable ({e}); fetching without verification")
            _ssl_ctx = ssl._create_unverified_context()
    return _ssl_ctx

def upstream(url, rng=None, method="GET"):
    if not re.match(r"^https?://", url): raise ValueError("only http(s) urls")
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, **({"Range": rng} if rng else {})})
    return urllib.request.urlopen(req, timeout=30, context=ssl_context())

def upstream_size(url):
    try:
        with upstream(url, "bytes=0-0") as r:
            cr = r.headers.get("Content-Range")
            if cr and "/" in cr: return int(cr.rsplit("/", 1)[1])
            cl = r.headers.get("Content-Length")
            return int(cl) if cl and r.status == 200 else None
    except Exception:
        return None

# ---------- link speed ----------
# Throughput per upstream host group, learned from the cache's full-speed downloads and from
# short probes. Pass-through streaming is not used: the browser reads a video only as fast
# as it buffers, so that would measure consumption, not the link.
def host_group(url):
    h = (urllib.parse.urlparse(url).hostname or "").lower()
    if h.endswith("googlevideo.com") or h.endswith("youtube.com"): return "youtube"
    if h.endswith("archive.org"): return "archive.org"
    return h

class Speed:
    def __init__(self):
        self.bps = {}                        # group -> bytes per second, exponentially smoothed
        self.lock = threading.Lock()
        for spec in opt("--fake-speed", "").split(","):     # tests: --fake-speed youtube=1.5,archive.org=0.8 (Mbps)
            if "=" in spec:
                g, mbps = spec.split("="); self.bps[g.strip()] = float(mbps) * 1e6 / 8
        self.fake = bool(self.bps)
    def record(self, url, nbytes, seconds):
        if self.fake or nbytes < 400_000 or seconds < 0.4: return
        g = host_group(url); v = nbytes / seconds
        with self.lock:
            old = self.bps.get(g)
            self.bps[g] = v if old is None else old * 0.6 + v * 0.4
    def get(self, url):
        return self.bps.get(host_group(url))
    def mbps(self):
        return {g: round(v * 8 / 1e6, 2) for g, v in self.bps.items()}
    def probe(self, url, seconds=2.5):
        """Download from url for a few seconds and record the rate; returns bytes/s or None."""
        if self.fake: return self.get(url)
        try:
            t0 = time.time(); got = 0
            with upstream(url) as r:
                while time.time() - t0 < seconds:
                    chunk = r.read(CHUNK)
                    if not chunk: break
                    got += len(chunk)
            el = time.time() - t0
            self.record(url, got, el)
            return got / el if el > 0 else None
        except Exception as e:
            print(f"  probe failed: {e}"); return None

speed = Speed()
ADAPT = "--no-adapt" not in sys.argv

# ---------- YouTube via yt-dlp ----------
YT_RE = re.compile(r"^(https?://)?(www\.|m\.)?(youtube\.com/(watch\?.*v=|shorts/|live/|embed/)|youtu\.be/)([A-Za-z0-9_-]{11})")
YT_MAX = int(opt("--yt-max", "1080"))        # hard ceiling on height
STALL_MARGIN = 2.0                           # a rendition is "safe" when the link delivers 2x its bitrate

def youtube_id(url):
    m = YT_RE.match(url or "")
    return m.group(5) if m else None

def find_ytdlp():
    local = os.path.join(ROOT, "yt-dlp.exe" if os.name == "nt" else "yt-dlp")
    if os.path.isfile(local): return local
    return shutil.which("yt-dlp")

YTDLP = find_ytdlp()
_yt_cache, _yt_lock = {}, threading.Lock()        # id -> (info json, time)

def yt_info(vid):
    with _yt_lock:
        hit = _yt_cache.get(vid)
        if hit and time.time() - hit[1] < 3600: return hit[0]
    cmd = [YTDLP, "--no-playlist", "--no-warnings", "-J", f"https://www.youtube.com/watch?v={vid}"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=150)
    except subprocess.TimeoutExpired:
        return {"error": "yt-dlp timed out"}
    if r.returncode != 0 or not r.stdout.strip():
        msg = (r.stderr or "").strip().splitlines()
        return {"error": (msg[-1] if msg else "yt-dlp failed")[:200]}
    try: info = json.loads(r.stdout)
    except Exception: return {"error": "yt-dlp returned no JSON"}
    with _yt_lock: _yt_cache[vid] = (info, time.time())
    return info

def yt_candidates(info):
    """H.264 mp4 renditions up to YT_MAX, best first: 1080p30, 720p30, then 720p60 before 1080p60
    (60 fps buys nothing for a VJ set and doubles the file), then the rest by height."""
    out = []
    for f in info.get("formats", []):
        if not f.get("url") or f.get("ext") != "mp4": continue
        if not str(f.get("vcodec", "")).startswith("avc1"): continue
        h = f.get("height") or 0
        if not h or h > YT_MAX: continue
        out.append({"id": f.get("format_id"), "height": h, "fps": f.get("fps") or 30, "tbr": f.get("tbr") or 0,
                    "url": f["url"], "video_only": f.get("acodec") in (None, "none")})
    def rank(f):
        h, hi = f["height"], f["fps"] > 30
        if h == 1080 and not hi: return 0
        if h == 720 and not hi: return 1
        if h == 720: return 2
        if h == 1080: return 3
        return 4
    out.sort(key=lambda f: (rank(f), -f["height"], f["fps"] > 30, f["tbr"]))
    return out

def yt_pick(cands):
    """The best rendition the link can carry with margin; the smallest one if nothing fits."""
    if not cands: return None, None
    bps = speed.get(cands[0]["url"])
    if not ADAPT or not bps:
        if ADAPT and not bps:
            bps = speed.probe(cands[0]["url"])
        if not bps: return cands[0], None
    for f in cands:
        if f["tbr"] * 1000 * STALL_MARGIN <= bps * 8: return f, bps
    return cands[-1], bps

def resolve_youtube(url):
    """{id, title, duration, thumbnail, height, fps, tbr, speedMbps, stall, url (stream), key} or {error}."""
    vid = youtube_id(url)
    if not vid: return {"error": "not a YouTube url"}
    if not YTDLP: return {"error": "yt-dlp not found: put yt-dlp.exe next to serve.py or install it"}
    info = yt_info(vid)
    if "error" in info: return info
    cands = yt_candidates(info)
    chosen, bps = yt_pick(cands)
    if not chosen: return {"error": "no H.264 mp4 rendition"}
    return {"id": vid, "title": info.get("title") or vid, "duration": info.get("duration"),
            "thumbnail": info.get("thumbnail") or "", "height": chosen["height"], "fps": chosen["fps"], "tbr": chosen["tbr"],
            "formatId": chosen["id"], "speedMbps": round(bps * 8 / 1e6, 2) if bps else None,
            "stall": bool(bps and chosen["tbr"] * 1000 * STALL_MARGIN > bps * 8),
            "url": chosen["url"], "key": f"https://www.youtube.com/watch?v={vid}"}

# ---------- cache ----------
class Cache:
    def __init__(self, folder, cap, reserve):
        self.dir, self.cap, self.reserve = folder, cap, reserve
        self.lock = threading.RLock()
        self.index_path = os.path.join(folder, "index.json")
        self.entries = {}
        self.fetching = {}           # key -> thread
        self.fetch_on_play = True
        os.makedirs(folder, exist_ok=True)
        try:
            self.entries = json.load(open(self.index_path, encoding="utf-8")).get("entries", {})
        except Exception:
            self.entries = {}
        # drop entries whose files are gone, and stale .part files
        for k, e in list(self.entries.items()):
            if not os.path.isfile(os.path.join(folder, e["file"])): del self.entries[k]
        for r, _, fs in os.walk(folder):
            for f in fs:
                if f.endswith(".part"):
                    try: os.remove(os.path.join(r, f))
                    except OSError: pass
        self.save()

    @staticmethod
    def key(url): return hashlib.sha1(url.encode()).hexdigest()[:16]

    def save(self):
        with self.lock:
            tmp = self.index_path + ".tmp"
            json.dump({"entries": self.entries, "saved": time.time()}, open(tmp, "w", encoding="utf-8"), indent=1)
            os.replace(tmp, self.index_path)

    def used(self): return sum(e["bytes"] for e in self.entries.values() if e.get("complete"))

    def info(self):
        with self.lock:
            return {"enabled": True, "dir": self.dir, "cap": self.cap, "reserve": self.reserve, "used": self.used(),
                    "count": sum(1 for e in self.entries.values() if e.get("complete")), "fetching": len(self.fetching),
                    "free": shutil.disk_usage(self.dir).free}

    def path_for(self, url, title=None):
        p = urllib.parse.urlparse(url)
        vid = youtube_id(url)
        if vid:
            slug = re.sub(r"[^A-Za-z0-9]+", "-", title or "").strip("-")[:60]
            return os.path.join("youtube", f"{vid}{'-' + slug if slug else ''}.mp4")
        name = urllib.parse.unquote(p.path.rsplit("/", 1)[-1]) or "video"
        name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)[:80]
        base, ext = os.path.splitext(name)
        ext = ext if ext.lower() in (".mp4", ".m4v", ".webm", ".mov", ".mkv", ".ogv") else ".mp4"
        host = re.sub(r"[^a-z0-9.-]", "_", p.hostname or "host")
        return os.path.join(host, f"{base}-{self.key(url)[:8]}{ext}")

    def complete_file(self, url):
        with self.lock:
            e = self.entries.get(self.key(url))
            if e and e.get("complete"):
                e["lastUsed"] = time.time(); self.save()
                return os.path.join(self.dir, e["file"])
        return None

    def make_room(self, size):
        """Evict least recently used complete clips until `size` fits under the cap and
        the disk keeps its reserve. Returns False if it cannot fit at all."""
        if size > self.cap: return False
        with self.lock:
            victims = sorted((e for e in self.entries.values() if e.get("complete")), key=lambda e: e.get("lastUsed") or e.get("added") or 0)
            def fits():
                return self.used() + size <= self.cap and shutil.disk_usage(self.dir).free - size >= self.reserve
            while not fits() and victims:
                v = victims.pop(0)
                try: os.remove(os.path.join(self.dir, v["file"]))
                except OSError: pass
                self.entries = {k: e for k, e in self.entries.items() if e is not v}
                print(f"  cache: evicted {v['file']}")
            self.save()
            return fits()

    def fetch(self, url, source=None, title=None):
        """Download the whole file in the background (once per key). `source` is the address
        to download from when it differs from the key (YouTube's expiring stream url)."""
        k = self.key(url)
        with self.lock:
            if k in self.fetching or (k in self.entries and self.entries[k].get("complete")): return
            t = threading.Thread(target=self._fetch, args=(url, k, source or url, title), daemon=True)
            self.fetching[k] = t
        t.start()

    def _fetch(self, url, k, source, title):
        try:
            size = upstream_size(source)
            if not size or not self.make_room(size):
                print(f"  cache: not caching {url[:60]} ({'unknown size' if not size else 'no room'})"); return
            rel = self.path_for(url, title); full = os.path.join(self.dir, rel); part = full + ".part"
            os.makedirs(os.path.dirname(full), exist_ok=True)
            got = 0; t0 = time.time()
            with upstream(source) as r, open(part, "wb") as f:
                while True:
                    chunk = r.read(CHUNK)
                    if not chunk: break
                    f.write(chunk); got += len(chunk)
            speed.record(source, got, time.time() - t0)
            if got != size:
                os.remove(part); print(f"  cache: size mismatch for {rel} ({got} of {size})"); return
            os.replace(part, full)
            with self.lock:
                self.entries[k] = {"url": url, "file": rel.replace("\\", "/"), "bytes": size, "added": time.time(), "lastUsed": time.time(), "complete": True, **({"title": title} if title else {})}
                self.save()
            print(f"  cache: stored {rel} ({size/1e6:.1f} MB), {self.used()/1e9:.2f}/{self.cap/1e9:.1f} GB used")
        except Exception as e:
            print(f"  cache: fetch failed for {url[:60]}: {e}")
        finally:
            with self.lock: self.fetching.pop(k, None)

    def clear(self):
        with self.lock:
            for e in self.entries.values():
                try: os.remove(os.path.join(self.dir, e["file"]))
                except OSError: pass
            self.entries = {}; self.save()

cache = Cache(CACHE_DIR, CACHE_CAP, RESERVE) if (CACHE_ON and PROXY_ON) else None

# ---------- handler ----------
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # --- static files with Range ---
    def send_head(self):
        path = self.translate_path(self.path)
        return self.send_file_head(path)

    def send_file_head(self, path):
        m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if not m or os.path.isdir(path) or not os.path.isfile(path):
            if path != self.translate_path(self.path):          # a cache file: serve whole
                f = open(path, "rb")
                self.send_response(200)
                self.send_header("Content-Type", self.guess_type(path))
                self.send_header("Content-Length", str(os.path.getsize(path)))
                self.end_headers()
                return f
            return super().send_head()
        size = os.path.getsize(path)
        if m.group(1): start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else size - 1
        else: start = max(0, size - int(m.group(2))); end = size - 1
        end = min(end, size - 1)
        if start > end: self.send_error(416); return None
        f = open(path, "rb"); f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return f

    def copyfile(self, src, dst):
        n = getattr(self, "_remaining", None)
        if n is None: return super().copyfile(src, dst)
        while n > 0:
            chunk = src.read(min(CHUNK, n))
            if not chunk: break
            dst.write(chunk); n -= len(chunk)
        self._remaining = None

    # --- proxy ---
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if not PROXY_ON and u.path.startswith("/proxy"): return self.send_error(404)
        if u.path == "/proxy": return self.proxy(u)
        if u.path == "/proxy/info": return self.json({"proxy": True, "cache": cache.info() if cache else {"enabled": False}, "fetchOnPlay": bool(cache and cache.fetch_on_play), "stick": STICK, "youtube": bool(YTDLP), "speed": speed.mbps(), "adapt": ADAPT, "ytMax": YT_MAX})
        if u.path == "/proxy/resolve":
            url = urllib.parse.parse_qs(u.query).get("url", [""])[0]
            info = resolve_youtube(url)
            return self.json({k: v for k, v in info.items() if k != "url"})
        if u.path == "/proxy/list":
            return self.json({"entries": [{"url": e["url"], "file": "cache/" + e["file"], "bytes": e["bytes"], "lastUsed": e.get("lastUsed"), "title": e.get("title")} for e in (cache.entries.values() if cache else []) if e.get("complete")]})
        return super().do_GET()

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}"
        if u.path == "/proxy/settings" and cache:
            try: data = json.loads(body)
            except Exception: data = {}
            if "fetchOnPlay" in data: cache.fetch_on_play = bool(data["fetchOnPlay"])
            return self.json({"fetchOnPlay": cache.fetch_on_play})
        if u.path == "/proxy/clear" and cache:
            cache.clear(); return self.json({"cleared": True, "cache": cache.info()})
        self.send_error(404)

    def json(self, obj):
        data = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers(); self.wfile.write(data)

    def proxy(self, u):
        url = urllib.parse.parse_qs(u.query).get("url", [""])[0]
        if not re.match(r"^https?://", url): self.send_error(400, "url must be http(s)"); return
        source, title = url, None
        if youtube_id(url):
            info = resolve_youtube(url)
            if "error" in info: self.send_error(502, f"YouTube: {info['error']}"); return
            url, source, title = info["key"], info["url"], info["title"]
        if cache:
            local = cache.complete_file(url)
            if local:
                f = self.send_file_head(local)
                if f:
                    try: self.copyfile(f, self.wfile)
                    finally: f.close()
                return
            if cache.fetch_on_play: cache.fetch(url, source, title)
        rng = self.headers.get("Range")
        try:
            r = upstream(source, rng)
        except Exception as e:
            self.send_error(502, f"upstream failed: {e}"); return
        with r:
            self.send_response(r.status)
            for h in ("Content-Type", "Content-Length", "Content-Range", "Last-Modified", "ETag"):
                v = r.headers.get(h)
                if v: self.send_header(h, v)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            try:
                while True:
                    chunk = r.read(CHUNK)
                    if not chunk: break
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass                                   # the browser moved on, normal for video

if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    url = f"http://localhost:{PORT}/"
    print(f"VJ Elato: serving {ROOT}\n  {url}   (Ctrl+C to stop)")
    if not PROXY_ON: print("  proxy off")
    elif cache: print(f"  proxy on, cache {CACHE_DIR} ({cache.used()/1e9:.2f}/{CACHE_CAP/1e9:.1f} GB used, {cache.info()['count']} clips)")
    else: print("  proxy on, cache off")
    if PROXY_ON: print(f"  youtube via {YTDLP}, up to {YT_MAX}p, {'quality follows the measured link' if ADAPT else 'fixed quality'}" if YTDLP else "  youtube off (no yt-dlp found)")
    if OPEN: threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try: srv.serve_forever()
    except KeyboardInterrupt: pass
