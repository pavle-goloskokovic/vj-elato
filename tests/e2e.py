"""End-to-end checks of player and controller in a real browser.

    python tests/e2e.py [--clip PATH] [--scenario smoke|reload|crop|all] [--keep]

What it does: stages the site into tests/_site (via tools/make_portable.py),
adds a test clip, serves it with tools/serve.py (byte ranges matter: without
them seeks snap to 0), opens player.html and controller.html as two tabs of
one Chrome and drives the controller.

Needs: Python 3.11+, `pip install playwright pillow`, and Google Chrome
installed. Playwright's bundled Chromium has no H.264 decoder, so the tests
use channel="chrome". The GPU flags keep Chrome off software rendering.

The clip: by default the first .mp4 found on a stick that carries
destockd-index.json (drives D: to H: on Windows); pass --clip to use any
H.264 mp4 of at least a few seconds.
"""
import argparse, asyncio, io, json, os, shutil, subprocess, sys, time, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "tests", "_site")
OUT = os.path.join(ROOT, "tests", "_out")
PORT = 8799
BASE = f"http://127.0.0.1:{PORT}/"
DESTOCKD_STREAM = "https://clips.destockd.com/clips/Universal%20Newsreel%20Volume%2021%2C%20Release%20160/shot_026.mp4"
CHROME_ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"]

# ---------- helpers ----------
def find_clip():
    for d in "DEFGH":
        idx = f"{d}:/destockd-index.json"
        if os.path.exists(idx):
            clips = json.load(open(idx, encoding="utf-8"))["clips"].values()
            best = min(clips, key=lambda r: abs((r["bytes"] or 0) - 12_000_000))
            return f"{d}:/" + best["path"]
    return None

def gray(png):
    from PIL import Image
    return list(Image.open(io.BytesIO(png)).convert("L").resize((96, 54)).getdata())
def diff(a, b): return round(sum(abs(x - y) for x, y in zip(a, b)) / len(a), 1)
def mean(a): return round(sum(a) / len(a), 1)

SET_PARAM = "([d,k,v]) => { const i=document.querySelector('.deck[data-deck=' + d + '] [data-param=' + k + ']'); i.value=v; i.dispatchEvent(new Event('input')); }"
SET_MASTER = "([k,v]) => { const i=document.querySelector('[data-master=' + k + ']'); i.value=v; i.dispatchEvent(new Event('input')); }"
CLICK_CMD = "([d,c]) => document.querySelector('.deck[data-deck=' + d + '] [data-cmd=' + c + ']').click()"
DECK_READY = "(d) => /\\d/.test(document.querySelector('.deck[data-deck=' + d + '] .d').textContent) || document.querySelector('.pane[data-pane=' + d + '] .badge').classList.contains('error')"
PLAYER_STATUS = """() => new Promise(res => { const bc=new BroadcastChannel('vj-elato'); bc.onmessage=e=>{ if(e.data.type==='status'){ res(e.data); bc.close(); } }; })"""
CARDS = """() => { const cards=[...document.querySelectorAll('#results .card')]; if (cards.length < 2) return {n: cards.length};
  const r0=cards[0].getBoundingClientRect(); let cols=1; while (cols<cards.length && Math.abs(cards[cols].getBoundingClientRect().top-r0.top)<2) cols++;
  return {n: cards.length, cols, cardH: Math.round(r0.height), gap: Math.round(cards[Math.min(cols, cards.length-1)].getBoundingClientRect().top - r0.bottom)}; }"""

class Check:
    def __init__(self): self.failed = []
    def __call__(self, name, ok, info=""):
        print(f"  {'ok  ' if ok else 'FAIL'} {name}{(' — ' + str(info)) if info else ''}")
        if not ok: self.failed.append(name)

async def open_pages(ctx, logs):
    player = await ctx.new_page(); ctrl = await ctx.new_page()
    for pg, tag in ((player, "player"), (ctrl, "controller")):
        pg.on("console", lambda m, t=tag: logs.append((t, m.type, m.text[:200])) if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e, t=tag: logs.append((t, "pageerror", str(e)[:300])))
    await player.goto(BASE + "player.html")
    await ctrl.goto(BASE + "controller.html")
    await ctrl.wait_for_function("document.querySelectorAll('#results .card').length > 20")
    await ctrl.wait_for_function("document.querySelector('#player-status').textContent.includes('connected')")
    return player, ctrl

async def load_url(ctrl, deck, url):
    await ctrl.click(".tabs button[data-tab=url]")
    await ctrl.select_option("#target-deck", deck)
    await ctrl.fill("#url-input", url); await ctrl.click("#url-load")
    await ctrl.wait_for_function(DECK_READY, arg=deck, timeout=90000)

# ---------- scenarios ----------
async def smoke(ctx, check, logs):
    player, ctrl = await open_pages(ctx, logs)
    cards = await ctrl.evaluate(CARDS)
    check("library cards render without overlapping", cards.get("gap", -1) > 0 and cards.get("cardH", 0) > 80, cards)
    await player.wait_for_function("document.querySelector('#overlay').classList.contains('hidden')")
    check("player overlay hides once the controller talks", True)
    await load_url(ctrl, "A", BASE + "test.mp4"); await ctrl.wait_for_timeout(2000)
    st = await ctrl.evaluate(PLAYER_STATUS)
    check("local clip plays on deck A via WebGL", st["decks"]["A"]["mode"] == "gl" and (st["decks"]["A"]["duration"] or 0) > 1, st["decks"]["A"]["mode"])
    await load_url(ctrl, "B", DESTOCKD_STREAM); await ctrl.wait_for_timeout(1500)
    st = await ctrl.evaluate(PLAYER_STATUS)
    check("Destockd stream on deck B falls back to CSS", st["decks"]["B"]["mode"] == "css" and not st["decks"]["B"]["error"], st["decks"]["B"])
    av = await ctrl.evaluate("() => ({bKaleido: document.querySelector('.deck[data-deck=B] [data-param=kaleido]').disabled, aKaleido: document.querySelector('.deck[data-deck=A] [data-param=kaleido]').disabled, aBlur: document.querySelector('.deck[data-deck=A] [data-param=blur]').disabled, bBlur: document.querySelector('.deck[data-deck=B] [data-param=blur]').disabled, fb: document.querySelector('[data-master=feedback]').disabled})")
    check("WebGL-only controls are disabled on the CSS deck, everything else stays on", av == {"bKaleido": True, "aKaleido": False, "aBlur": False, "bBlur": False, "fb": False}, av)
    # safe load: a source that does not exist must leave the current clip playing
    srcA = await player.evaluate("document.getElementById('deckA').currentSrc")
    await ctrl.click(".tabs button[data-tab=url]"); await ctrl.select_option("#target-deck", "A")
    await ctrl.fill("#url-input", BASE + "does-not-exist.mp4"); await ctrl.click("#url-load")
    await ctrl.wait_for_function("document.querySelector('.pane[data-pane=A] .badge').classList.contains('error')", timeout=30000)
    keep = await player.evaluate("() => { const v = document.getElementById('deckA'); return {src: v.currentSrc, paused: v.paused, t: v.currentTime} }")
    title = await ctrl.evaluate("document.querySelector('.deck[data-deck=A] .title').textContent")
    check("a failing load keeps the current clip playing and the controller falls back to it", keep["src"] == srcA and not keep["paused"] and keep["t"] > 0 and title == "test.mp4", {**keep, "title": title})
    await ctrl.evaluate(CLICK_CMD, ["A", "pause"]); await ctrl.evaluate(SET_MASTER, ["crossfade", "0"]); await ctrl.wait_for_timeout(600)
    plain = gray(await player.screenshot())
    await ctrl.evaluate(SET_PARAM, ["A", "blur", "20"]); await ctrl.wait_for_timeout(500)
    blurred = gray(await player.screenshot())
    check("blur works on the WebGL deck", diff(plain, blurred) > 1.5, diff(plain, blurred))
    await ctrl.evaluate(SET_PARAM, ["A", "blur", "0"]); await ctrl.wait_for_timeout(300)
    for k, v in (("kaleido", "5"), ("hue", "90"), ("pixelate", "0.3")): await ctrl.evaluate(SET_PARAM, ["A", k, v])
    await ctrl.wait_for_timeout(600)
    fx = gray(await player.screenshot())
    check("deck effects change the player picture", diff(plain, fx) > 5, diff(plain, fx))
    st = await ctrl.evaluate(PLAYER_STATUS)
    check("stepped kaleido slider sends the step value (position 5 = 8 segments)", st["decks"]["A"]["params"]["kaleido"] == 8, st["decks"]["A"]["params"]["kaleido"])
    await ctrl.evaluate(CLICK_CMD, ["A", "play"]); await ctrl.evaluate(SET_MASTER, ["feedback", "0.95"]); await ctrl.evaluate(SET_MASTER, ["fbZoom", "1.05"]); await ctrl.wait_for_timeout(2000)
    fb = gray(await player.screenshot())
    check("feedback trail changes the picture", diff(fx, fb) > 5, diff(fx, fb))
    await ctrl.evaluate(SET_MASTER, ["feedback", "0"]); await ctrl.evaluate(SET_MASTER, ["strobe", "2"]); await ctrl.wait_for_timeout(300)
    shots = [mean(gray(await player.screenshot())) for _ in range(6)]
    check("strobe blinks the output", min(shots) < 2 and max(shots) > 10, shots)
    await ctrl.evaluate(SET_MASTER, ["strobe", "0"])
    await ctrl.evaluate(SET_MASTER, ["crossfade", "0.3"]); await ctrl.wait_for_timeout(500)
    op = await ctrl.evaluate("document.querySelector('#pvB').style.opacity")
    check("crossfader is linear for normal blend (B at 30 %)", abs(float(op) - 0.3) < 0.02, op)
    await ctrl.click(".deck[data-deck=A] .reset"); await ctrl.wait_for_timeout(300)
    st = await ctrl.evaluate(PLAYER_STATUS)
    p = st["decks"]["A"]["params"]
    check("reset fx returns kaleido, hue, pixelate, opacity, speed", p["kaleido"] == 0 and p["hue"] == 0 and p["pixelate"] == 0 and p["opacity"] == 1 and p["speed"] == 1, p)
    await ctrl.screenshot(path=os.path.join(OUT, "smoke_controller.png"))
    await player.screenshot(path=os.path.join(OUT, "smoke_player.png"))

async def reload(ctx, check, logs):
    player, ctrl = await open_pages(ctx, logs)
    await load_url(ctrl, "A", BASE + "test.mp4")
    await load_url(ctrl, "B", DESTOCKD_STREAM)
    await ctrl.evaluate(SET_PARAM, ["A", "hue", "90"]); await ctrl.evaluate(SET_MASTER, ["feedback", "0.8"]); await ctrl.evaluate(SET_MASTER, ["crossfade", "0.3"])
    await ctrl.wait_for_timeout(3000)
    pa = await player.evaluate("document.getElementById('deckA').currentTime")
    await ctrl.reload()
    await ctrl.wait_for_function("document.querySelector('#player-status').textContent.includes('connected')")
    await ctrl.wait_for_timeout(3500)
    r = await ctrl.evaluate("() => ({titles:[...document.querySelectorAll('.deck .title')].map(e=>e.textContent), hue:document.querySelector('.deck[data-deck=A] [data-param=hue]').value, fb:document.querySelector('[data-master=feedback]').value, xf:document.querySelector('#crossfade').value, pvA:document.querySelector('#pvA').currentTime, pvB:document.querySelector('#pvB').currentTime})")
    pa2 = await player.evaluate("document.getElementById('deckA').currentTime")
    check("controller reload restores clips and settings", r["titles"] == ["test.mp4", "shot_026.mp4"] and r["hue"] == "90" and r["fb"] == "0.8" and r["xf"] == "0.3", r)
    await player.wait_for_timeout(1000)
    pa2b = await player.evaluate("document.getElementById('deckA').currentTime")
    check("controller reload leaves the player playing", pa2b != pa2 and not await player.evaluate("document.getElementById('deckA').paused"), f"{pa:.1f} -> {pa2:.1f} -> {pa2b:.1f} (the 14 s clip may have looped)")
    # the preview is nudged to the player at most every 2 s, and the 14 s clip loops, so sample
    # for a few seconds rather than once
    synced, pair = False, None
    for _ in range(8):
        pv = await ctrl.evaluate("document.querySelector('#pvA').currentTime")
        pl = await player.evaluate("document.getElementById('deckA').currentTime")
        pair = (pv, pl)
        if abs(pv - pl) < 1.2 and r["pvB"] > 0: synced = True; break
        await ctrl.wait_for_timeout(1000)
    check("previews resume after controller reload", synced, f"preview {pair[0]:.1f} vs player {pair[1]:.1f}")
    await player.reload()
    # with safe loading the clip is on screen only once it can play at the resumed position
    await ctrl.wait_for_function("""() => new Promise(res => { const bc=new BroadcastChannel('vj-elato'); bc.onmessage=e=>{ if(e.data.type==='status'){ const a=e.data.decks.A; if (a.meta && !a.loading && a.ready) { res(true); bc.close(); } } }; setTimeout(() => { res(false); bc.close(); }, 900); })""", timeout=60000, polling=1000)
    await player.wait_for_timeout(500)
    st = await ctrl.evaluate(PLAYER_STATUS)
    pa3 = await player.evaluate("document.getElementById('deckA').currentTime")
    check("player reload resumes clips, settings and position", st["decks"]["A"]["mode"] == "gl" and st["decks"]["A"]["params"]["hue"] == 90 and st["master"]["feedback"] == 0.8 and abs(pa3 - pa2) < 6, f"{pa2:.1f} -> {pa3:.1f}")

async def crop(ctx, check, logs):
    player, ctrl = await open_pages(ctx, logs)
    await load_url(ctrl, "A", BASE + "test.mp4"); await ctrl.wait_for_timeout(1500)
    await ctrl.evaluate(CLICK_CMD, ["A", "pause"]); await ctrl.wait_for_timeout(500)
    plain = gray(await player.screenshot())
    await ctrl.click(".deck[data-deck=A] .bars"); await ctrl.wait_for_timeout(400)
    contain = gray(await player.screenshot())
    await ctrl.evaluate(SET_PARAM, ["A", "fit", "cover"]); await ctrl.wait_for_timeout(400)
    cover = gray(await player.screenshot())
    check("4:3 bars button sets 12.5 % side crop", (await ctrl.evaluate("document.querySelector('.deck[data-deck=A] [data-param=cropX]').parentElement.querySelector('output').value")) == "12.5%")
    check("cover differs from contain once bars are cropped", diff(contain, cover) > 10, diff(contain, cover))

async def proxy(ctx, check, logs):
    import urllib.request
    info = json.load(urllib.request.urlopen(BASE + "proxy/info", timeout=10))
    check("server advertises the proxy", info.get("proxy") is True and info["cache"]["enabled"], info.get("cache"))
    player, ctrl = await open_pages(ctx, logs)
    check("controller shows the proxy status", await ctrl.evaluate("!document.querySelector('#proxy-status').classList.contains('hidden')"))
    await load_url(ctrl, "A", DESTOCKD_STREAM); await ctrl.wait_for_timeout(2500)
    st = await ctrl.evaluate(PLAYER_STATUS)
    badge = await ctrl.evaluate("document.querySelector('.pane[data-pane=A] .badge').textContent")
    check("Destockd stream through the proxy plays on WebGL", st["decks"]["A"]["mode"] == "gl" and not st["decks"]["A"]["error"] and (st["decks"]["A"]["duration"] or 0) > 1, f"mode={st['decks']['A']['mode']} badge={badge}")
    cached = None
    for _ in range(40):
        lst = json.load(urllib.request.urlopen(BASE + "proxy/list", timeout=10))["entries"]
        cached = next((e for e in lst if e["url"] == DESTOCKD_STREAM), None)
        if cached: break
        await ctrl.wait_for_timeout(1500)
    site = os.path.join(SITE, "vj-elato")
    on_disk = cached and os.path.getsize(os.path.join(SITE, cached["file"])) == cached["bytes"]
    check("fetch on play cached the whole clip on the stick", bool(cached) and on_disk, cached and f"{cached['file']} {cached['bytes']} bytes")
    info = json.load(urllib.request.urlopen(BASE + "proxy/info", timeout=10))
    check("cache usage is reported", info["cache"]["used"] > 0 and info["cache"]["count"] >= 1, f"{info['cache']['used']} bytes, {info['cache']['count']} clips")
    await load_url(ctrl, "B", DESTOCKD_STREAM); await ctrl.wait_for_timeout(1500)
    st = await ctrl.evaluate(PLAYER_STATUS)
    check("second play is served from the cache and still WebGL", st["decks"]["B"]["mode"] == "gl" and (st["decks"]["B"]["duration"] or 0) > 1)
    await ctrl.evaluate("fetch('proxy/settings', {method:'POST', body: JSON.stringify({fetchOnPlay:false})})"); await ctrl.wait_for_timeout(500)
    info = json.load(urllib.request.urlopen(BASE + "proxy/info", timeout=10))
    check("fetch-on-play toggle reaches the server", info["fetchOnPlay"] is False)

YOUTUBE_TEST = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"     # Big Buck Bunny, Blender Foundation, CC-BY

async def youtube(ctx, check, logs):
    import urllib.request
    info = json.load(urllib.request.urlopen(BASE + "proxy/info", timeout=10))
    if not info.get("youtube"):
        print("  skip: no yt-dlp on this machine"); return
    player, ctrl = await open_pages(ctx, logs)
    await ctrl.click(".tabs button[data-tab=url]"); await ctrl.select_option("#target-deck", "A")
    await ctrl.fill("#url-input", YOUTUBE_TEST); await ctrl.click("#url-load")
    await ctrl.wait_for_function("/\d+p\d*|YouTube:/.test(document.querySelector('#url-status').textContent)", timeout=200000)
    status = await ctrl.evaluate("document.querySelector('#url-status').textContent")
    import re
    check("yt-dlp resolves the video (title, height and link speed shown)", "Big Buck Bunny" in status and re.search(r"\d+p\d*", status) is not None and "link" in status, status)
    await ctrl.wait_for_function(DECK_READY, arg="A", timeout=120000); await ctrl.wait_for_timeout(2500)
    st = await ctrl.evaluate(PLAYER_STATUS)
    check("YouTube video plays through the proxy on WebGL", st["decks"]["A"]["mode"] == "gl" and not st["decks"]["A"]["error"] and (st["decks"]["A"]["duration"] or 0) > 60, f"mode={st['decks']['A']['mode']} dur={st['decks']['A']['duration']} err={st['decks']['A']['error']}")
    check("thumbnail comes from YouTube", "ytimg.com" in (await ctrl.evaluate("document.querySelector('.pane[data-pane=A] img').src")))

async def adapt(ctx, check, logs):
    """Runs against a server started with --fake-speed youtube=1.2: the pick must drop below 720p."""
    import urllib.request
    info = json.load(urllib.request.urlopen(BASE + "proxy/info", timeout=10))
    if not info.get("youtube"):
        print("  skip: no yt-dlp on this machine"); return
    check("server reports the (faked) link speed", info.get("speed", {}).get("youtube") == 1.2, info.get("speed"))
    r = json.load(urllib.request.urlopen(BASE + "proxy/resolve?url=" + urllib.parse.quote(YOUTUBE_TEST, safe=""), timeout=200))
    check("a 1.2 Mbps link gets a rendition below 720p", "error" not in r and r["height"] < 720 and r["tbr"] * 1000 * 2 <= 1.2e6 + 1, {k: r.get(k) for k in ("height", "fps", "tbr", "speedMbps", "stall", "error")})

async def stick(ctx, check, logs):
    """The server lists the stick: no folder picker, clips play as same-origin URLs, stars save on the stick."""
    import urllib.request
    idx = json.load(urllib.request.urlopen(BASE + "stick/index", timeout=10))
    check("stick/index lists the test clip", any(f["path"] == "clips/stick-test.mp4" for f in idx["files"]), [f["path"] for f in idx["files"]][:3])
    player, ctrl = await open_pages(ctx, logs)
    await ctrl.wait_for_function("document.querySelector('#folder-status').textContent.includes('clips')", timeout=20000)
    status = await ctrl.evaluate("document.querySelector('#folder-status').textContent")
    check("library comes from the server without a picker", status.startswith("stick") and await ctrl.evaluate("document.querySelector('#pick-folder').classList.contains('hidden')"), status)
    await ctrl.click(".tabs button[data-tab=stick]")
    await ctrl.fill("#search", "stick-test")                 # the proxy scenario may have left cached clips on this stick
    await ctrl.wait_for_function("document.querySelectorAll('#results .card').length === 1")
    await ctrl.wait_for_timeout(1500)
    thumb = await ctrl.evaluate("document.querySelector('#results .card img').src")
    check("stick clip without a sibling image gets a grabbed-frame thumbnail", thumb.startswith("blob:"), thumb[:40])
    await ctrl.select_option("#target-deck", "A"); await ctrl.click("#results .card >> nth=0")
    await ctrl.wait_for_function(DECK_READY, arg="A"); await ctrl.wait_for_timeout(1500)
    st = await ctrl.evaluate(PLAYER_STATUS)
    badge = await ctrl.evaluate("document.querySelector('.pane[data-pane=A] .badge').textContent")
    check("stick clip plays via the server URL on WebGL with the stick badge", st["decks"]["A"]["mode"] == "gl" and badge.startswith("stick"), f"mode={st['decks']['A']['mode']} badge={badge}")
    await ctrl.hover("#results .card >> nth=0"); await ctrl.click("#results .card >> nth=0 >> button.star"); await ctrl.wait_for_timeout(800)
    path = os.path.join(SITE, "vj-elato-collections.json")
    saved = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    check("star writes vj-elato-collections.json on the stick through the server", "clips/stick-test.mp4" in saved.get("collections", {}).get("Starred", []), saved)

async def search(ctx, check, logs):
    import urllib.request
    info = json.load(urllib.request.urlopen(BASE + "proxy/info", timeout=10))
    if not info.get("youtube"):
        print("  skip: no yt-dlp on this machine"); return
    player, ctrl = await open_pages(ctx, logs)
    check("YouTube tab is offered when yt-dlp is available", not await ctrl.evaluate("document.querySelector('.tabs button[data-tab=youtube]').classList.contains('hidden')"))
    await ctrl.click(".tabs button[data-tab=youtube]")
    await ctrl.fill("#search", "big buck bunny blender"); await ctrl.press("#search", "Enter")
    await ctrl.wait_for_function("document.querySelectorAll('#results .card').length >= 5", timeout=120000)
    titles = await ctrl.evaluate("[...document.querySelectorAll('#results .card .name')].map(e => e.textContent)")
    check("search lists results with titles and YouTube thumbnails", any("Bunny" in t for t in titles) and "ytimg.com" in await ctrl.evaluate("document.querySelector('#results .card img').src"), titles[:3])
    await ctrl.select_option("#target-deck", "B"); await ctrl.click("#results .card >> nth=0")
    await ctrl.wait_for_function("/\\d+p\\d*|YouTube:/.test(document.querySelector('#yt-status').textContent)", timeout=200000)
    await ctrl.wait_for_function(DECK_READY, arg="B", timeout=120000); await ctrl.wait_for_timeout(2000)
    st = await ctrl.evaluate(PLAYER_STATUS)
    check("a search result loads and plays through the proxy on WebGL", st["decks"]["B"]["mode"] == "gl" and (st["decks"]["B"]["duration"] or 0) > 10, f"mode={st['decks']['B']['mode']} dur={st['decks']['B']['duration']}")
    r = json.load(urllib.request.urlopen(BASE + "proxy/resolve?url=" + urllib.parse.quote(YOUTUBE_TEST, safe=""), timeout=200))
    check("resolve carries a SponsorBlock segment list", isinstance(r.get("segments"), list), r.get("segments"))

async def unplug(ctx, check, logs):
    """Simulates pulling the stick (the server's --unplug-flag file) and plugging it back."""
    import urllib.request, urllib.error
    flag = os.path.join(OUT, "unplugged.flag")
    player, ctrl = await open_pages(ctx, logs)
    await ctrl.wait_for_function("document.querySelector('#folder-status').textContent.includes('clips')", timeout=20000)
    await ctrl.click(".tabs button[data-tab=stick]"); await ctrl.fill("#search", "stick-test")
    await ctrl.wait_for_function("document.querySelectorAll('#results .card').length === 1")
    await ctrl.select_option("#target-deck", "A"); await ctrl.click("#results .card >> nth=0")
    await ctrl.wait_for_function(DECK_READY, arg="A"); await ctrl.wait_for_timeout(2000)
    open(flag, "w").write("1")
    try:
        info = json.load(urllib.request.urlopen(BASE + "proxy/info", timeout=10))
        check("server reports the stick as absent", info.get("stickPresent") is False)
        try: urllib.request.urlopen(BASE + "stick/index", timeout=10); code = 200
        except urllib.error.HTTPError as e: code = e.code
        check("stick requests answer 503 while it is absent", code == 503, code)
        await ctrl.wait_for_function("!document.querySelector('#stick-status').classList.contains('hidden')", timeout=15000)
        check("controller shows the stick as removed", True)
        t1 = await player.evaluate("document.getElementById('deckA').currentTime")
    finally:
        os.remove(flag)
    await ctrl.wait_for_function("document.querySelector('#stick-status').classList.contains('hidden')", timeout=15000)
    await ctrl.wait_for_timeout(2500)
    status = await ctrl.evaluate("document.querySelector('#folder-status').textContent")
    t2 = await player.evaluate("() => { const v = document.getElementById('deckA'); return {t: v.currentTime, paused: v.paused, src: v.currentSrc} }")
    check("stick back: pill clears, library rescanned, deck A still plays its stick clip", status.startswith("stick") and "clips" in status and not t2["paused"] and t2["t"] > t1 and "stick-test" in t2["src"], {"status": status, **t2})

async def logging(ctx, check, logs):
    """Events from both pages and the server land in the session file on the laptop and on the stick."""
    import urllib.request
    player, ctrl = await open_pages(ctx, logs)
    await load_url(ctrl, "A", BASE + "test.mp4")
    await load_url(ctrl, "B", BASE + "does-not-exist.mp4")
    await ctrl.wait_for_function("document.querySelector('.pane[data-pane=B] .badge').classList.contains('error')", timeout=30000)
    await ctrl.wait_for_timeout(3000)                      # batches flush every 2 s
    info = json.load(urllib.request.urlopen(BASE + "proxy/info", timeout=10))
    text = urllib.request.urlopen(BASE + "log/current", timeout=10).read().decode("utf-8")
    lines = [json.loads(l) for l in text.splitlines() if l.strip()]
    srcs = {l["src"] for l in lines}; types = {l["type"] for l in lines}
    check("session file has the server header and events from both pages", "session.start" in types and {"server", "controller", "player"} <= srcs, sorted(srcs))
    check("clip loads and the failed load are logged", "clip.load" in types and "clip.loadfail" in types and "deck.loadfail" in types, sorted(t for t in types if t.startswith(("clip", "deck"))))
    stick_file = os.path.join(SITE, "vj-elato-logs", info["log"])
    laptop_file = os.path.join(SITE, "vj-elato", "logs", info["log"])
    check("the same session file exists on the laptop and on the stick", os.path.isfile(laptop_file) and os.path.isfile(stick_file) and os.path.getsize(stick_file) > 200, {"laptop": os.path.isfile(laptop_file), "stick": os.path.isfile(stick_file)})
    check("no event is logged more than once per status tick (no chatter)", len(lines) < 60, len(lines))

async def mia(ctx, check, logs):
    """Moving Image Archive tab: collections from the catalog, a clip plays, and (with the server) the
    describe-a-shot search returns picture matches."""
    import urllib.request
    player, ctrl = await open_pages(ctx, logs)
    await ctrl.click(".tabs button[data-tab=mia]")
    await ctrl.wait_for_function("document.querySelectorAll('#results .card').length > 20")
    n = await ctrl.evaluate("document.querySelectorAll('#results .card').length")
    thumb = await ctrl.evaluate("document.querySelector('#results .card img').src")
    check("collections render with r2 thumbnails", n > 20 and "r2.dev" in thumb and "/thumbnails/" in thumb, f"{n} cards, {thumb[:60]}")
    await ctrl.select_option("#filter", "col:film-countdowns")
    await ctrl.wait_for_timeout(500)
    n2 = await ctrl.evaluate("document.querySelectorAll('#results .card').length")
    check("a collection filter narrows the list", 0 < n2 < n, n2)
    await ctrl.select_option("#target-deck", "B"); await ctrl.click("#results .card >> nth=0")
    await ctrl.wait_for_function(DECK_READY, arg="B", timeout=90000); await ctrl.wait_for_timeout(1500)
    st = await ctrl.evaluate(PLAYER_STATUS)
    info = json.load(urllib.request.urlopen(BASE + "proxy/info", timeout=10)) if await ctrl.evaluate("!document.querySelector('#proxy-status').classList.contains('hidden')") else None
    expect = "gl" if info else "css"
    check(f"a Moving Image clip plays ({'through the proxy on WebGL' if info else 'as a CSS layer on the web'})", st["decks"]["B"]["mode"] == expect and not st["decks"]["B"]["error"] and (st["decks"]["B"]["duration"] or 0) > 0.5, f"mode={st['decks']['B']['mode']} err={st['decks']['B']['error']}")
    if info:
        await ctrl.select_option("#filter", "describe")
        await ctrl.fill("#search", "a crowd of people cheering"); await ctrl.press("#search", "Enter")
        await ctrl.wait_for_function("document.querySelectorAll('#results .card').length >= 5", timeout=90000)
        subs = await ctrl.evaluate("[...document.querySelectorAll('#results .card .sub')].slice(0,3).map(e => e.textContent)")
        check("describe-a-shot search returns ranked picture matches", all("match" in s for s in subs), subs)

async def midi(ctx, check, logs):
    """The MIDI engine driven with synthetic messages from the Mixtrack Pro map: faders, soft takeover,
    toggles, momentary buttons, the shift layer and the browse encoder."""
    player, ctrl = await open_pages(ctx, logs)
    await load_url(ctrl, "A", BASE + "test.mp4"); await ctrl.wait_for_timeout(1000)
    dev = json.load(open(os.path.join(ROOT, "midi", "numark-mixtrack-pro.json"), encoding="utf-8"))
    await ctrl.evaluate("(dev) => window.vjMidi.useDevice(dev)", dev)
    pill = await ctrl.evaluate("document.querySelector('#midi-status').textContent")
    check("engine accepts the device map", "virtual" in pill, pill)
    c = dev["controls"]
    send = lambda name, val: ctrl.evaluate("([n,v]) => window.vjMidi.handle([0xB0, n, v])", [c[name]["num"], val])
    note = lambda name, on: ctrl.evaluate("([n,v]) => window.vjMidi.handle([0x90, n, v])", [c[name]["num"], 127 if on else 0])
    # every absolute control needs to pass the on-screen value once (soft takeover): the crossfade is at 0
    await send("xfader", 0); await send("xfader", 64); await ctrl.wait_for_timeout(200)
    check("crossfader moves the master crossfade", abs(float(await ctrl.evaluate("document.querySelector('#crossfade').value")) - 0.5) < 0.02)
    # soft takeover: opacity is 1.0, a fader sitting at 10 must not jump it; passing through engages
    await send("A.fader", 10); await ctrl.wait_for_timeout(100)
    op1 = await ctrl.evaluate("document.querySelector('.deck[data-deck=A] [data-param=opacity]').value")
    for v in (60, 100, 127, 110): await send("A.fader", v)
    await ctrl.wait_for_timeout(200)
    op2 = await ctrl.evaluate("document.querySelector('.deck[data-deck=A] [data-param=opacity]').value")
    check("soft takeover: no jump until the fader passes the on-screen value, then it follows", float(op1) == 1 and abs(float(op2) - 110 / 127) < 0.02, (op1, op2))
    await note("A.hot2", True); await note("A.hot2", False); await ctrl.wait_for_timeout(300)
    st = await ctrl.evaluate(PLAYER_STATUS)
    check("hot cue 2 toggles mirror top-bottom on the player", st["decks"]["A"]["params"]["mirror"] == 2, st["decks"]["A"]["params"]["mirror"])
    await note("A.fx", True); await ctrl.wait_for_timeout(300)
    k1 = (await ctrl.evaluate(PLAYER_STATUS))["decks"]["A"]["params"]["kaleido"]
    await note("A.fx", False); await ctrl.wait_for_timeout(300)
    k2 = (await ctrl.evaluate(PLAYER_STATUS))["decks"]["A"]["params"]["kaleido"]
    check("effect button is momentary: kaleido while held, back on release", k1 == 6 and k2 == 0, (k1, k2))
    # zoom 1.0 sits at 20 % of the knob's travel: the knob has to cross it before it takes over
    await note("A.scratch", True)
    for v in (10, 20, 30, 64, 96): await send("A.treble", v)
    await note("A.scratch", False); await ctrl.wait_for_timeout(300)
    z = (await ctrl.evaluate(PLAYER_STATUS))["decks"]["A"]["params"]
    check("holding scratch shifts the treble knob to zoom and leaves hue alone", z["zoom"] > 2.5 and z["hue"] == 0, (z["zoom"], z["hue"]))
    await note("A.play", True); await note("A.play", False); await ctrl.wait_for_timeout(500)
    check("play button pauses the running deck", (await ctrl.evaluate(PLAYER_STATUS))["decks"]["A"]["paused"] is True)
    await ctrl.click(".tabs button[data-tab=destockd]"); await ctrl.wait_for_function("document.querySelectorAll('#results .card').length > 20")
    for _ in range(3): await send("browse.turn", 1)
    sel = await ctrl.evaluate("[...document.querySelectorAll('#results .card')].findIndex(c => c.classList.contains('selected'))")
    check("browse encoder moves the library cursor", sel == 2, sel)

async def lightshow(ctx, check, logs):
    """The idle light show: starts after the idle time, writes animated LED frames, stops on the first
    input and the state LEDs come back; every animation renders on the virtual display."""
    player, ctrl = await open_pages(ctx, logs)
    dev = json.load(open(os.path.join(ROOT, "midi", "numark-mixtrack-pro.json"), encoding="utf-8"))
    await ctrl.evaluate("(dev) => { window.vjMidi.state.ledLog = []; window.vjMidi.useDevice(dev); }", dev)
    await ctrl.wait_for_function("!document.querySelector('#lightshow').classList.contains('hidden')", timeout=5000)
    check("the lights panel appears for a device with a layout", True)
    names = await ctrl.evaluate("window.vjShow.get().animations.map(a => a.name)")
    lit = await ctrl.evaluate("""() => { const s = window.vjShow.get(); const out = {}; for (const a of s.animations) { let n = 0; for (let t = 0; t < a.seconds; t += 0.5) { const r = s.frame(Date.now() + t * 1000, a); n += Object.values(r.on).filter(Boolean).length; } out[a.name] = n; } return out; }""")
    check("every animation lights something over its run", all(v > 0 for v in lit.values()), lit)
    await ctrl.evaluate("() => { document.querySelector('#show-idle').value = 2; document.querySelector('#show-idle').dispatchEvent(new Event('change')); window.vjMidi.state.lastInput = Date.now() - 5000; }")
    await ctrl.wait_for_function("window.vjMidi.state.show === true", timeout=6000)
    await ctrl.wait_for_timeout(2500)
    n1 = await ctrl.evaluate("window.vjMidi.state.ledLog.length"); frames = await ctrl.evaluate("window.vjShow.frames()")
    check("the show starts after the idle time and writes LED frames", frames > 20 and n1 > 20, {"frames": frames, "ledWrites": n1})
    c = dev["controls"]
    await ctrl.evaluate("([n]) => window.vjMidi.handle([0x90, n, 127])", [c["A.hot1"]["num"]]); await ctrl.evaluate("([n]) => window.vjMidi.handle([0x90, n, 0])", [c["A.hot1"]["num"]])
    await ctrl.wait_for_timeout(600)
    n2 = await ctrl.evaluate("window.vjMidi.state.ledLog.length")
    last = await ctrl.evaluate("window.vjMidi.state.ledLog.slice(-60)")
    stopped = await ctrl.evaluate("window.vjMidi.state.show === false")
    hot1_on = any(e[0] == "A.hot1" and e[1] for e in last)
    check("any input stops the show and the state LEDs return (hot cue 1 lit for mirror)", stopped and hot1_on, {"stopped": stopped, "hot1": hot1_on})
    await ctrl.wait_for_timeout(1200)
    n3 = await ctrl.evaluate("window.vjMidi.state.ledLog.length")
    check("no more frames are written after the show stopped", n3 - n2 < 5, n3 - n2)
    for name in ("ripples", "radar", "life"):
        await ctrl.select_option("#show-anim", name); await ctrl.wait_for_timeout(1200)
        await ctrl.locator("#lightshow").screenshot(path=os.path.join(OUT, f"lightshow_{name}.png"))

SCENARIOS = {"smoke": smoke, "reload": reload, "crop": crop, "proxy": proxy, "youtube": youtube, "adapt": adapt, "stick": stick, "search": search, "unplug": unplug, "logging": logging, "mia": mia, "midi": midi, "lightshow": lightshow}

async def run(names, keep):
    from playwright.async_api import async_playwright
    check = Check(); logs = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, channel="chrome", args=CHROME_ARGS)
        try:
            for name in names:
                print(f"[{name}]")
                ctx = await browser.new_context(viewport={"width": 1280, "height": 720})
                ctx.set_default_timeout(120000); ctx.set_default_navigation_timeout(120000)
                try:
                    await SCENARIOS[name](ctx, check, logs)
                except Exception as e:
                    check(f"{name} scenario completes", False, repr(e)[:200])
                finally:
                    await ctx.close()
        finally:
            await browser.close()
    problems = [l for l in logs if l[1] in ("error", "pageerror") and "proxy/info" not in l[2] and "404" not in l[2]]   # the proxy probe 404s on a static server, by design
    check("no console errors or page errors", not problems, problems[:3])
    return check.failed

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip"); ap.add_argument("--scenario", default="all"); ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    clip = a.clip or find_clip()
    if not clip or not os.path.exists(clip):
        sys.exit("no test clip: plug in the stick with destockd-index.json or pass --clip <file.mp4>")
    shutil.rmtree(SITE, ignore_errors=True); os.makedirs(OUT, exist_ok=True)
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "make_portable.py"), SITE], check=True, stdout=subprocess.DEVNULL)
    site = os.path.join(SITE, "vj-elato")
    shutil.copy(clip, os.path.join(site, "test.mp4"))
    os.makedirs(os.path.join(SITE, "clips"), exist_ok=True)
    shutil.copy(clip, os.path.join(SITE, "clips", "stick-test.mp4"))      # seen by the server's stick scan
    print(f"site: {site}\nclip: {clip}")
    names = list(SCENARIOS) if a.scenario == "all" else [a.scenario]
    failed = []
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from watchdog import Watchdog, builds_running
    if builds_running(): sys.exit("a build or install is running on this machine; run the browser tests later")
    # the run carries its own hard limits: a deadline and a memory ceiling for the browser,
    # because a tool timeout would not stop it
    deadline = 420 * max(1, len(names)) if a.scenario != "all" else 1800
    with Watchdog(deadline_s=deadline, max_mb=1500, trace=os.environ.get("VJ_MEMTRACE") == "1") as dog:
        # smoke/reload/crop run against plain static hosting (as on GitHub Pages: no proxy),
        # the proxy scenario against the full local server
        for flags, group in ((["--no-proxy"], [n for n in names if n not in ("proxy", "youtube", "adapt", "stick", "search", "unplug", "logging")]),
                             (["--cache-gb", "1", "--unplug-flag", os.path.join(OUT, "unplugged.flag")], [n for n in names if n in ("proxy", "youtube", "stick", "search", "unplug", "logging", "mia")]),
                             (["--cache-gb", "1", "--fake-speed", "youtube=1.2"], [n for n in names if n == "adapt"])):
            if not group or dog.fired: continue
            srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "tools", "serve.py"), str(PORT), site, "--no-browser", *flags], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                time.sleep(1.5)
                print(f"server flags: {' '.join(flags)}")
                failed += asyncio.run(run(group, a.keep))
            finally:
                srv.terminate(); srv.wait(timeout=10); time.sleep(0.5)
        if dog.fired: failed.append(f"watchdog ({dog.fired})")
    if not a.keep: shutil.rmtree(SITE, ignore_errors=True)
    print("\n" + ("ALL PASSED" if not failed else f"FAILED: {', '.join(failed)}"))
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
