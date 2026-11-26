"""Make a copy of the tool that runs with no internet and no install, from any folder.

usage: python tools/make_portable.py <destination> [--no-python] [--bundle] [--zip [FILE]]
       e.g.  python tools/make_portable.py F:\\            the copy on a USB stick
             python tools/make_portable.py dist --zip      dist/vj-elato.zip, to hand to others

Creates <destination>/vj-elato/ with the pages, the catalogs, the local server and its
launchers (serve.cmd for Windows, serve.sh for Linux and macOS, serve.command to double-click
on macOS). The folder is self-contained and may be renamed or moved anywhere, a USB stick's
root folder included: clips go in its clips/ folder, the proxy cache in clips/cache/, the
session logs in logs/. Those three are never touched by a later run of this script, so
running it again on the same destination is the update.

What is bundled besides the tool:
  on Windows (or with --bundle, or --zip): the official embeddable Python for Windows (a 10 MB
      zip from python.org, no installer) and yt-dlp.exe, so serve.cmd works on any Windows laptop
  with --bundle or --zip: also the plain "yt-dlp" file, a Python zip that Linux and macOS run
      on their own python3
  --no-python: none of it (the GitHub Pages build)
"""
import io, os, shutil, sys, urllib.request, zipfile

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = ["index.html", "player.html", "controller.html"]
DIRS = ["css", "js", "catalog", "midi"]
SERVE = ["serve.py", "serve.cmd", "serve.sh", "serve.command"]
EXECUTABLE = {"serve.sh", "serve.command", "yt-dlp"}      # get the executable bit in the zip
KEPT = ("clips", "logs")                                   # the user's: never written into a zip, never cleared
PY_VERSION = "3.13.10"
PY_URL = f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip"
YTDLP_EXE_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
YTDLP_PY_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"

START_HERE = """VJ Elato

Unpack this folder anywhere: a disk, a USB stick, the stick's root. It can be renamed and moved.

Start it
  Windows   double-click serve.cmd
            (Windows may warn about a downloaded file: More info, then Run anyway)
  macOS     double-click serve.command
            (the first time: right-click it, Open, then Open again)
  Linux     in a terminal:  sh serve.sh

macOS and Linux need Python 3; Windows needs nothing, a Python comes with this folder.
The browser opens http://localhost:8765/. Use Chrome or Edge. Open the player, put it on the
projector, then work in the controller.

Your clips
  Put video files in the clips folder, in any subfolders. They show up in the Library tab,
  with thumbnails, and get every effect. Without clips of your own there are the catalogs
  (Destockd, Spelunkr, Moving Image), YouTube and the generators.

What is where
  clips/         your clips
  clips/cache/   streams the tool has fetched, so they play again without the network (2 GB at most)
  logs/          a log per session, for when something goes wrong

On a USB stick the tool copies itself to the laptop when it starts and runs from there, so
pulling the stick does not stop the show: the clips come back when the stick does.
Nothing is installed and nothing is sent anywhere; to remove the tool, delete this folder.
"""

def download(url, least=1_000_000):
    """urllib first; curl if Python cannot use the machine's certificate store (seen on
    some Windows installs). Both verify TLS; there is no unverified fallback."""
    import subprocess
    try: return urllib.request.urlopen(url, timeout=120).read()
    except Exception as e: print(f"  urllib could not fetch it ({e}); trying curl")
    try:
        r = subprocess.run(["curl", "-sSL", "--max-time", "180", url], capture_output=True)
        if r.returncode == 0 and len(r.stdout) > least: return r.stdout
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

def fetch_ytdlp(dest, name, url, what):
    path = os.path.join(dest, name)
    if os.path.isfile(path):
        print(f"{name} already there (delete it to refresh)"); return
    print(f"downloading {name} ({what}) ...")
    data = download(url)
    if not data: print("  could not download; YouTube will need yt-dlp on PATH"); return
    open(path, "wb").write(data); print(f"  saved ({len(data)/1e6:.1f} MB)")

def copy_text(src, dst, newline):
    """A launcher with the line endings its shell wants, whatever the checkout has."""
    text = open(src, encoding="utf-8").read().replace("\r\n", "\n")
    with open(dst, "w", encoding="utf-8", newline=newline) as f: f.write(text)

def make_zip(dest, path):
    """The folder as one zip, under its own name, without the user's clips and logs."""
    top = os.path.basename(dest)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for r, dirs, fs in os.walk(dest):
            rel_dir = os.path.relpath(r, dest)
            if rel_dir == ".": dirs[:] = [d for d in dirs if d not in KEPT]
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for f in sorted(fs):
                arc = top + "/" + (f if rel_dir == "." else rel_dir.replace(os.sep, "/") + "/" + f)
                info = zipfile.ZipInfo.from_file(os.path.join(r, f), arc)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3                                          # Unix: the mode below is honoured on unpacking
                info.external_attr = (0o100755 if rel_dir == "." and f in EXECUTABLE else 0o100644) << 16
                with open(os.path.join(r, f), "rb") as fh: z.writestr(info, fh.read())
        info = zipfile.ZipInfo(top + "/clips/PUT-YOUR-CLIPS-HERE.txt")
        info.create_system = 3; info.external_attr = 0o100644 << 16
        z.writestr(info, "Video files in this folder, in any subfolders, show up in the controller's Library tab.\n")
    print(f"zip written to {path}  ({os.path.getsize(path)/1e6:.1f} MB)")

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args: print(__doc__); sys.exit(1)
    want_zip = "--zip" in sys.argv
    zip_path = None
    if want_zip:
        i = sys.argv.index("--zip")
        nxt = sys.argv[i + 1] if i + 1 < len(sys.argv) else ""
        if nxt.lower().endswith(".zip"): zip_path = nxt; args = [a for a in args if a != nxt]
    dest = os.path.join(args[0], "vj-elato")
    zip_path = zip_path or os.path.join(args[0], "vj-elato.zip")
    os.makedirs(dest, exist_ok=True)
    for p in PAGES: shutil.copy2(os.path.join(SRC, p), dest)
    for d in DIRS:
        shutil.rmtree(os.path.join(dest, d), ignore_errors=True)
        shutil.copytree(os.path.join(SRC, d), os.path.join(dest, d))
    for s in SERVE:
        src = os.path.join(SRC, "tools", s)
        if s == "serve.py": shutil.copy2(src, dest)
        else: copy_text(src, os.path.join(dest, s), "\r\n" if s.endswith(".cmd") else "\n")
    if os.name != "nt":
        for s in ("serve.sh", "serve.command"): os.chmod(os.path.join(dest, s), 0o755)
    for old in ("serve.ps1",):
        try: os.remove(os.path.join(dest, old))
        except OSError: pass
    shutil.copy2(os.path.join(SRC, "README.md"), dest)
    os.makedirs(os.path.join(dest, "clips"), exist_ok=True)
    # version stamp for the session log: git commit when available, else the date
    import subprocess, time
    try: ver = subprocess.run(["git", "-C", SRC, "log", "-1", "--format=%h %cd", "--date=short"], capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception: ver = ""
    open(os.path.join(dest, "version.txt"), "w", encoding="utf-8").write((ver or "unknown") + f" (packed {time.strftime('%Y-%m-%d %H:%M')})\n")
    with open(os.path.join(dest, "START-HERE.txt"), "w", encoding="utf-8", newline="\r\n") as f: f.write(START_HERE)
    if "--no-python" not in sys.argv:
        everything = want_zip or "--bundle" in sys.argv
        if os.name == "nt" or everything:
            fetch_python(dest)
            fetch_ytdlp(dest, "yt-dlp.exe", YTDLP_EXE_URL, "YouTube resolver for Windows")
        if everything:
            fetch_ytdlp(dest, "yt-dlp", YTDLP_PY_URL, "YouTube resolver for Linux and macOS")
            if os.name != "nt": os.chmod(os.path.join(dest, "yt-dlp"), 0o755)
    total = sum(os.path.getsize(os.path.join(r, f)) for r, ds, fs in os.walk(dest) for f in fs
                if not os.path.relpath(r, dest).split(os.sep)[0] in KEPT)
    print(f"portable copy written to {dest}  ({total/1e6:.1f} MB without clips and logs)")
    if want_zip: make_zip(dest, zip_path)

if __name__ == "__main__":
    main()
