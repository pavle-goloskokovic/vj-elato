"""Copy the tool onto a USB stick so it runs with no internet and no install.

usage: python tools/make_portable.py <destination> [--no-python]
       e.g.  python tools/make_portable.py F:\\

Creates <destination>/vj-elato/ with the two pages, the catalogs, the local server and,
on first run, the official embeddable Python for Windows (a 10 MB zip from python.org,
no installer) so serve.cmd works on any Windows laptop. macOS and Linux use their own
python3 via serve.sh. Pick the stick's root as the clip folder in the controller; the
proxy cache goes to <stick root>/cache.
"""
import io, os, shutil, sys, urllib.request, zipfile

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = ["index.html", "player.html", "controller.html"]
DIRS = ["css", "js", "catalog"]
SERVE = ["serve.py", "serve.cmd", "serve.sh"]
PY_VERSION = "3.13.10"
PY_URL = f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip"
YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"

def download(url):
    """urllib first; curl if Python cannot use the machine's certificate store (seen on
    some Windows installs). Both verify TLS; there is no unverified fallback."""
    import subprocess
    try: return urllib.request.urlopen(url, timeout=120).read()
    except Exception as e: print(f"  urllib could not fetch it ({e}); trying curl")
    try:
        r = subprocess.run(["curl", "-sSL", "--max-time", "180", url], capture_output=True)
        if r.returncode == 0 and len(r.stdout) > 1_000_000: return r.stdout
    except Exception as e: print(f"  curl: {e}")
    return None

def fetch_python(dest):
    pydir = os.path.join(dest, "python")
    if os.path.isfile(os.path.join(pydir, "python.exe")):
        print(f"embeddable Python already in {pydir}"); return
    print(f"downloading embeddable Python {PY_VERSION} from python.org ...")
    data = download(PY_URL)
    if not data:
        print("  could not download; serve.cmd will use an installed Python instead"); return
    zipfile.ZipFile(io.BytesIO(data)).extractall(pydir)
    print(f"  unpacked to {pydir} ({sum(os.path.getsize(os.path.join(pydir, f)) for f in os.listdir(pydir))/1e6:.1f} MB)")

def fetch_ytdlp(dest):
    exe = os.path.join(dest, "yt-dlp.exe")
    if os.path.isfile(exe):
        print("yt-dlp.exe already on the stick (delete it to refresh)"); return
    print("downloading yt-dlp.exe (YouTube resolver) ...")
    data = download(YTDLP_URL)
    if not data: print("  could not download; YouTube will need yt-dlp on PATH"); return
    open(exe, "wb").write(data); print(f"  saved ({len(data)/1e6:.1f} MB)")

def main():
    if len(sys.argv) < 2: print(__doc__); sys.exit(1)
    dest = os.path.join(sys.argv[1], "vj-elato")
    os.makedirs(dest, exist_ok=True)
    for p in PAGES: shutil.copy2(os.path.join(SRC, p), dest)
    for d in DIRS:
        shutil.rmtree(os.path.join(dest, d), ignore_errors=True)
        shutil.copytree(os.path.join(SRC, d), os.path.join(dest, d))
    for s in SERVE: shutil.copy2(os.path.join(SRC, "tools", s), dest)
    for old in ("serve.ps1",):
        try: os.remove(os.path.join(dest, old))
        except OSError: pass
    shutil.copy2(os.path.join(SRC, "README.md"), dest)
    # version stamp for the session log: git commit when available, else the date
    import subprocess, time
    try: ver = subprocess.run(["git", "-C", SRC, "log", "-1", "--format=%h %cd", "--date=short"], capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception: ver = ""
    open(os.path.join(dest, "version.txt"), "w", encoding="utf-8").write((ver or "unknown") + f" (packed {time.strftime('%Y-%m-%d %H:%M')})\n")
    with open(os.path.join(dest, "START-HERE.txt"), "w", encoding="utf-8") as f:
        f.write("VJ Elato, portable copy\n\n"
                "Windows:      double-click serve.cmd\n"
                "macOS/Linux:  run ./serve.sh\n\n"
                "The browser opens http://localhost:8765/. Open the player, then the controller,\n"
                "and pick this stick's root folder as the clip folder. Works without internet:\n"
                "stick clips, their thumbnails, collections and effects are all local.\n"
                "With internet, streams go through the local proxy, get the WebGL effects, and\n"
                "are cached in <stick>/cache (2 GB, least recently used clips make room).\n")
    if "--no-python" not in sys.argv and os.name == "nt": fetch_python(dest); fetch_ytdlp(dest)
    total = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(dest) for f in fs)
    print(f"portable copy written to {dest}  ({total/1e6:.1f} MB)")

if __name__ == "__main__":
    main()
