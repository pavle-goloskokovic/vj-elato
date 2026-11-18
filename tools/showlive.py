"""Play the idle light show on the real controller through headless Chrome (someone watches the unit).

usage: python -I tools/showlive.py [seconds] [--anim NAME] [--trace]
       seconds   how long to play; 0 = until the stop file appears (hard limit 3 h). Default 60.
       --anim    play one animation instead of cycling
       --trace   print the browser's memory every 10 s (to look for a leak)

Stop a run started with 0 by creating tests/_out/show.stop; the state LEDs are restored on a
clean stop. The controller must be plugged in. The page is served from a staged copy in
tests/_site on port 8793; both the copy and the server are removed at the end.
"""
import argparse, asyncio, os, shutil, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
from watchdog import Watchdog, builds_running
from playwright.async_api import async_playwright

PORT = 8793
SITE = os.path.join(ROOT, "tests", "_site")
STOP = os.path.join(ROOT, "tests", "_out", "show.stop")
# The page stays open for a long time and nothing here depends on frame rate, so cap
# requestAnimationFrame to 15 fps: the preview canvas then costs a fraction of the CPU.
RAF_CAP = """(() => {
  const STEP = 1000 / 15, raf = window.requestAnimationFrame.bind(window);
  let queue = new Map(), nextId = 1, last = -1e9, pumping = false;
  const pump = (now) => {
    if (now - last < STEP - 2) { raf(pump); return; }
    last = now; pumping = false;
    const run = queue; queue = new Map(); run.forEach((cb) => cb(now));
  };
  window.requestAnimationFrame = (cb) => { const id = nextId++; queue.set(id, cb); if (!pumping) { pumping = true; raf(pump); } return id; };
  window.cancelAnimationFrame = (id) => { queue.delete(id); };
})();"""


async def main(limit, anim):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, channel="chrome", args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
        try:
            ctx = await browser.new_context()
            await ctx.grant_permissions(["midi", "midi-sysex"], origin=f"http://127.0.0.1:{PORT}")
            await ctx.add_init_script(script=RAF_CAP)
            page = await ctx.new_page()
            await page.goto(f"http://127.0.0.1:{PORT}/controller.html")
            await page.wait_for_function("window.vjMidi && window.vjMidi.state.status === 'connected'", timeout=20000)
            await page.wait_for_function("window.vjShow && window.vjShow.get()", timeout=10000)
            if anim: await page.select_option("#show-anim", anim)
            await page.evaluate("window.vjShow.start()")
            t0 = time.time(); last = ""
            while time.time() - t0 < limit and not os.path.exists(STOP):
                await page.wait_for_timeout(1000)
                name = await page.evaluate("document.querySelector('#show-name').textContent")
                if name != last: print(f"  +{time.time() - t0:4.0f}s  {name}", flush=True); last = name
            await page.evaluate("window.vjShow.stop()")
            print("stopped; state LEDs restored", flush=True)
        finally:
            await browser.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("seconds", nargs="?", type=int, default=60)
    ap.add_argument("--anim", default=""); ap.add_argument("--trace", action="store_true")
    a = ap.parse_args()
    limit = a.seconds if a.seconds else 3 * 3600
    if builds_running(): sys.exit("a build is running; try later")
    os.makedirs(os.path.dirname(STOP), exist_ok=True)
    if os.path.exists(STOP): os.remove(STOP)
    shutil.rmtree(SITE, ignore_errors=True)
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "make_portable.py"), SITE, "--no-python"], check=True, stdout=subprocess.DEVNULL)
    srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "tools", "serve.py"), str(PORT), os.path.join(SITE, "vj-elato"), "--no-browser", "--no-proxy"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(1.5)
        with Watchdog(deadline_s=limit + 90, max_mb=800, trace=a.trace):
            asyncio.run(main(limit, a.anim))
    finally:
        srv.terminate(); shutil.rmtree(SITE, ignore_errors=True)
