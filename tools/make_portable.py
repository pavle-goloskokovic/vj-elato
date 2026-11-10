"""Copy the tool onto a USB stick so it runs with no internet and no install.

usage: python tools/make_portable.py <destination>      e.g.  python tools/make_portable.py F:\\

Creates <destination>/vj-elato/ with the two pages, the catalogs and the local
server scripts. On the stick, double-click vj-elato/serve.cmd (Windows) or run
vj-elato/serve.sh (macOS, Linux): it serves the folder on http://localhost:8765/
and opens the browser. Pick the stick's root as the clip folder in the controller.
"""
import os, shutil, sys

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = ["index.html", "player.html", "controller.html"]
DIRS = ["css", "js", "catalog"]
SERVE = ["serve.py", "serve.cmd", "serve.ps1", "serve.sh"]

def main():
    if len(sys.argv) < 2: print(__doc__); sys.exit(1)
    dest = os.path.join(sys.argv[1], "vj-elato")
    os.makedirs(dest, exist_ok=True)
    for p in PAGES: shutil.copy2(os.path.join(SRC, p), dest)
    for d in DIRS:
        shutil.rmtree(os.path.join(dest, d), ignore_errors=True)
        shutil.copytree(os.path.join(SRC, d), os.path.join(dest, d))
    for s in SERVE: shutil.copy2(os.path.join(SRC, "tools", s), dest)
    shutil.copy2(os.path.join(SRC, "README.md"), dest)
    with open(os.path.join(dest, "START-HERE.txt"), "w", encoding="utf-8") as f:
        f.write("VJ Elato, portable copy\n\n"
                "Windows:      double-click serve.cmd\n"
                "macOS/Linux:  run ./serve.sh\n\n"
                "The browser opens http://localhost:8765/. Open the player, then the controller,\n"
                "and pick this stick's root folder as the clip folder. Works without internet:\n"
                "stick clips, their thumbnails, collections and effects are all local.\n"
                "Destockd and Spelunkr thumbnails and streams need a connection.\n")
    total = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(dest) for f in fs)
    print(f"portable copy written to {dest}  ({total/1e6:.1f} MB)")

if __name__ == "__main__":
    main()
