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
    await ctrl.evaluate(CLICK_CMD, ["A", "pause"]); await ctrl.evaluate(SET_MASTER, ["crossfade", "0"]); await ctrl.wait_for_timeout(600)
    plain = gray(await player.screenshot())
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
    check("controller reload leaves the player playing", pa2 > pa, f"{pa:.1f} -> {pa2:.1f}")
    check("previews resume after controller reload", abs(r["pvA"] - pa2) < 1.5 and r["pvB"] > 0, f"preview {r['pvA']:.1f} vs player {pa2:.1f}")
    await player.reload(); await player.wait_for_timeout(4000)
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
    await ctrl.wait_for_function("/p$|YouTube:/.test(document.querySelector('#url-status').textContent)", timeout=200000)
    status = await ctrl.evaluate("document.querySelector('#url-status').textContent")
    check("yt-dlp resolves the video (title and height shown)", "Big Buck Bunny" in status and status.endswith("p"), status)
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

SCENARIOS = {"smoke": smoke, "reload": reload, "crop": crop, "proxy": proxy, "youtube": youtube, "adapt": adapt}

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
    print(f"site: {site}\nclip: {clip}")
    names = list(SCENARIOS) if a.scenario == "all" else [a.scenario]
    failed = []
    # smoke/reload/crop run against plain static hosting (as on GitHub Pages: no proxy),
    # the proxy scenario against the full local server
    for flags, group in ((["--no-proxy"], [n for n in names if n not in ("proxy", "youtube", "adapt")]),
                         (["--cache-gb", "1"], [n for n in names if n in ("proxy", "youtube")]),
                         (["--cache-gb", "1", "--fake-speed", "youtube=1.2"], [n for n in names if n == "adapt"])):
        if not group: continue
        srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "tools", "serve.py"), str(PORT), site, "--no-browser", *flags], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(1.5)
            print(f"server flags: {' '.join(flags)}")
            failed += asyncio.run(run(group, a.keep))
        finally:
            srv.terminate(); srv.wait(timeout=10); time.sleep(0.5)
    if not a.keep: shutil.rmtree(SITE, ignore_errors=True)
    print("\n" + ("ALL PASSED" if not failed else f"FAILED: {', '.join(failed)}"))
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
