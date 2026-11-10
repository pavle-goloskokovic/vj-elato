import json, time, subprocess, urllib.parse, sys
def get(url):
    r = subprocess.run(["curl", "-s", "--max-time", "40", url], capture_output=True)
    return json.loads(r.stdout)
films = get("https://destockd.com/api/films?per_page=1000")
names = [f["film"] for f in films["films"]]
print("films listed:", len(names), "total field:", films.get("total"), "has_more:", films.get("has_more"))
out = {}
for i, n in enumerate(names):
    try:
        d = get("https://destockd.com/api/film/" + urllib.parse.quote(n, safe=""))
        out[n] = {"archive_url": d.get("archive_url"), "shot_count": d.get("shot_count"),
                  "shots": [{"shot": s["shot"], "clip": s["clip"]} for s in d.get("shots", [])]}
    except Exception as e:
        out[n] = {"error": str(e)}
    if i % 100 == 0: print(i, n, file=sys.stderr, flush=True)
    time.sleep(0.1)
json.dump(out, open("destockd_films.json", "w"))
ids = {v["archive_url"].rsplit("/", 1)[-1] for v in out.values() if v.get("archive_url")}
print("films fetched:", len(out), "errors:", sum(1 for v in out.values() if "error" in v))
print("total shots:", sum(len(v.get("shots", [])) for v in out.values()))
print("unique archive.org identifiers:", len(ids))
open("destockd_ids.txt", "w").write("\n".join(sorted(ids)))
