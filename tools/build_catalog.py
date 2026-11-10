"""Build the compact catalogs the controller loads, from the raw scan data.

usage: python -I tools/build_catalog.py <scan_dir> <out_dir>
scan_dir holds destockd_films.json, destockd_collections.json, lineup.json, manifests/, spelunkr_meta.json, vs_meta.json
"""
import glob, json, os, re, sys, time, urllib.parse

scan, out = sys.argv[1], sys.argv[2]
rd = lambda p: json.load(open(os.path.join(scan, p), encoding="utf-8"))

# ---------- Destockd ----------
films_raw = rd("destockd_films.json")
cols_raw = rd("destockd_collections.json")
films, film_index = [], {}
for name, v in films_raw.items():
    shots = v["shots"]
    seg = None; nums = []
    for s in shots:
        m = re.fullmatch(r"https://clips\.destockd\.com/clips/([^/]+)/shot_(\d+)\.mp4", s["clip"])
        assert m, s["clip"]
        seg = seg or m.group(1); assert seg == m.group(1)
        assert s["shot"] == f"shot_{int(m.group(2)):03d}", s
        nums.append(int(m.group(2)))
    film_index[name] = len(films)
    films.append({"n": name, "p": seg, "ia": v["archive_url"].rsplit("/", 1)[-1], "shots": nums})
collections = []
for c in cols_raw["collections"]:
    clips = [[film_index[r["film"]], int(r["shot"].split("_")[1]), r["bytes"]]
             for u, r in cols_raw["clips"].items() if c["slug"] in r["collections"]]
    collections.append({"slug": c["slug"], "name": c["name"], "description": c.get("description", ""), "clips": clips})
destockd = {"generated": time.strftime("%Y-%m-%d"), "source": "destockd.com",
            "clipBase": "https://clips.destockd.com/clips/", "keyframeBase": "https://destockd.com/keyframes/",
            "films": films, "collections": collections}
json.dump(destockd, open(os.path.join(out, "destockd.json"), "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
print("destockd: films", len(films), "shots", sum(len(f["shots"]) for f in films), "collections", len(collections))

# ---------- Spelunkr ----------
lineup = rd("lineup.json")
meta = {}
for p in ("spelunkr_meta.json", "vs_meta.json"): meta.update(rd(p))
by_channel = {}
for f in glob.glob(os.path.join(scan, "manifests", "*.json")):
    m = json.load(open(f, encoding="utf-8")); by_channel[m["channel"]] = m
channels = []; n_items = 0
for c in lineup["channels"]:
    m = by_channel.get(c["id"])
    if not m: print("no manifest for", c["id"]); continue
    items = []
    for it in m["items"]:
        fn = it.get("mp4") or it.get("file")
        size = (meta.get(it["id"]) or {}).get("files", {}).get(fn) or (meta.get(it["id"]) or {}).get("files", {}).get(urllib.parse.unquote(fn))
        rec = {"id": it["id"], "f": fn, "d": it.get("duration"), "t": it.get("title")}
        if it.get("year"): rec["y"] = it["year"]
        if it.get("inS"): rec["in"] = it["inS"]
        if it.get("outS"): rec["out"] = it["outS"]
        if it.get("show"): rec["show"] = it["show"]
        if size: rec["b"] = size
        items.append(rec)
    n_items += len(items)
    channels.append({"id": c["id"], "name": c["name"], "emoji": c.get("emoji", ""), "color": c.get("color", ""),
                     "description": c.get("description", ""), "items": items})
spelunkr = {"generated": time.strftime("%Y-%m-%d"), "source": "spelunkr.tv lineup + archive.org",
            "base": "https://archive.org/download/", "thumbBase": "https://archive.org/services/img/", "channels": channels}
json.dump(spelunkr, open(os.path.join(out, "spelunkr.json"), "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
print("spelunkr: channels", len(channels), "items", n_items)
