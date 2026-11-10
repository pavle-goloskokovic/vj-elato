# usage: python -I ia_sizes.py items.json out.json   (items keys "identifier|file"; file may be "None")
import json, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
items = json.load(open(sys.argv[1], encoding="utf-8"))
ids = sorted({k.split("|")[0] for k in items})
def meta(ident):
    for attempt in range(3):
        r = subprocess.run(["curl", "-s", "--max-time", "60", f"https://archive.org/metadata/{ident}"], capture_output=True)
        try:
            d = json.loads(r.stdout)
            if d: return ident, d
        except Exception: pass
        time.sleep(2 + attempt * 3)
    return ident, None
out = {}
with ThreadPoolExecutor(4) as ex:
    for n, (ident, d) in enumerate(ex.map(meta, ids)):
        if d is None: out[ident] = None; continue
        files = d.get("files", [])
        out[ident] = {"item_size": d.get("item_size"),
                      "files": {f["name"]: int(f.get("size", 0) or 0) for f in files if f.get("name")},
                      "mp4s": {f["name"]: int(f.get("size", 0) or 0) for f in files if f["name"].lower().endswith((".mp4",".m4v",".mkv",".avi",".mov",".mpg",".mpeg",".ogv",".webm"))}}
        if n % 200 == 0: print(n, ident, file=sys.stderr, flush=True)
json.dump(out, open(sys.argv[2], "w"))
print("identifiers:", len(ids), "fetched:", sum(1 for v in out.values() if v), "failed:", sum(1 for v in out.values() if not v))
