"""VJ Elato local server: static files with byte ranges, plus a video proxy with a cache.

usage: python serve.py [port] [folder] [--no-browser] [--cache-gb N] [--reserve-mb N] [--cache-dir DIR] [--no-cache] [--no-proxy]
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
The stream is video-only; the player is muted anyway.

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

# ---------- YouTube via yt-dlp ----------
YT_RE = re.compile(r"^(https?://)?(www\.|m\.)?(youtube\.com/(watch\?.*v=|shorts/|live/|embed/)|youtu\.be/)([A-Za-z0-9_-]{11})")
# H.264 video-only (the player is muted anyway), smallest file that still looks right on a
# projector: 1080p30, then 720p30, then for 60 fps uploads (which have no 30 fps rendition
# above 480p) 720p60 before 1080p60, then whatever H.264 or mp4 there is.
YT_FORMAT = ("bv*[vcodec^=avc1][height=1080][fps<=30]/bv*[vcodec^=avc1][height=720][fps<=30]"
             "/bv*[vcodec^=avc1][height=720]/bv*[vcodec^=avc1][height=1080]"
             "/bv*[vcodec^=avc1][height<=1080]/bv*[height<=1080][ext=mp4]/b[height<=1080][ext=mp4]/b[ext=mp4]/b")

def youtube_id(url):
    m = YT_RE.match(url or "")
    return m.group(5) if m else None

def find_ytdlp():
    local = os.path.join(ROOT, "yt-dlp.exe" if os.name == "nt" else "yt-dlp")
    if os.path.isfile(local): return local
    return shutil.which("yt-dlp")

YTDLP = find_ytdlp()
_yt_cache, _yt_lock = {}, threading.Lock()        # id -> (resolved dict, time)

def resolve_youtube(url):
    """{id, title, duration, thumbnail, height, url (direct stream), key (canonical watch url)} or {error}."""
    vid = youtube_id(url)
    if not vid: return {"error": "not a YouTube url"}
    with _yt_lock:
        hit = _yt_cache.get(vid)
        if hit and time.time() - hit[1] < 3600: return hit[0]
    if not YTDLP: return {"error": "yt-dlp not found: put yt-dlp.exe next to serve.py or install it"}
    cmd = [YTDLP, "--no-playlist", "--no-warnings", "-f", YT_FORMAT,
           "--print", "%(id)s\t%(title)s\t%(duration)s\t%(thumbnail)s\t%(height)s\t%(vcodec)s", "--print", "%(url)s",
           f"https://www.youtube.com/watch?v={vid}"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=150)
    except subprocess.TimeoutExpired:
        return {"error": "yt-dlp timed out"}
    lines = [l for l in r.stdout.splitlines() if l.strip()]
    if r.returncode != 0 or len(lines) < 2:
        msg = (r.stderr or "").strip().splitlines()
        return {"error": (msg[-1] if msg else "yt-dlp failed")[:200]}
    meta, direct = lines[0].split("\t"), lines[-1].strip()
    info = {"id": meta[0], "title": meta[1], "duration": float(meta[2]) if meta[2] not in ("", "NA") else None,
            "thumbnail": meta[3] if meta[3] != "NA" else "", "height": meta[4], "vcodec": meta[5],
            "url": direct, "key": f"https://www.youtube.com/watch?v={meta[0]}"}
    with _yt_lock: _yt_cache[vid] = (info, time.time())
    return info

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
            got = 0
            with upstream(source) as r, open(part, "wb") as f:
                while True:
                    chunk = r.read(CHUNK)
                    if not chunk: break
                    f.write(chunk); got += len(chunk)
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
        if u.path == "/proxy/info": return self.json({"proxy": True, "cache": cache.info() if cache else {"enabled": False}, "fetchOnPlay": bool(cache and cache.fetch_on_play), "stick": STICK, "youtube": bool(YTDLP)})
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
    if PROXY_ON: print(f"  youtube via {YTDLP}" if YTDLP else "  youtube off (no yt-dlp found)")
    if OPEN: threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try: srv.serve_forever()
    except KeyboardInterrupt: pass
