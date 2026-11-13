"""Build the compact catalogs the controller loads, from the raw scan data.

usage: python -I tools/build_catalog.py [scan_dir] [out_dir]   (defaults: data/catalog-scan, catalog)
scan_dir holds destockd_films.json, destockd_collections.json, lineup.json, manifests/, spelunkr_meta.json, vs_meta.json
"""
import glob, gzip, json, os, re, sys, time, urllib.parse

scan = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "catalog-scan")
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "catalog")

def rd(name):
    """Read a JSON file from the scan folder; large ones are kept gzipped in the repo."""
    p = os.path.join(scan, name)
    if os.path.exists(p): return json.load(open(p, encoding="utf-8"))
    with gzip.open(p + ".gz", "rt", encoding="utf-8") as f: return json.load(f)

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

# ---------- Moving Image Archive ----------
# clips: [sourceIdx, startMs, endMs, colour(1=colour), aspect("4:3"...), path]; the thumbnail is the
# same path under /thumbnails/ with .jpg, which the build asserts for every clip.
try:
    mia_clips = rd("mia_clips.json"); mia_cols = rd("mia_collections.json")
except FileNotFoundError:
    mia_clips = None
if mia_clips:
    MIA_BASE = "https://pub-075ff01374c04555b51c9bc50f258b42.r2.dev/"
    sources, src_index, clips, clip_index = [], {}, [], {}
    for cid, c in sorted(mia_clips.items(), key=lambda kv: (kv[1].get("sourceTitle") or "", kv[1].get("startSeconds") or 0)):
        s = c["sourceSlug"]
        if s not in src_index:
            src_index[s] = len(sources); sources.append({"slug": s, "title": c.get("sourceTitle") or s, "year": c.get("sourceYear")})
        assert c["videoUrl"].startswith(MIA_BASE), c["videoUrl"]
        path = c["videoUrl"][len(MIA_BASE):]
        derived = MIA_BASE + path.replace("/clips/", "/thumbnails/").rsplit(".", 1)[0] + ".jpg"
        rec = [src_index[s], int(round((c.get("startSeconds") or 0) * 1000)), int(round((c.get("endSeconds") or 0) * 1000)),
               1 if c.get("colorMode") == "color" else 0, c.get("aspectRatio") or "", path]
        if c.get("thumbnailUrl") and c["thumbnailUrl"] != derived:          # a handful differ: keep theirs
            rec.append(c["thumbnailUrl"][len(MIA_BASE):] if c["thumbnailUrl"].startswith(MIA_BASE) else c["thumbnailUrl"])
        clip_index[cid] = len(clips)
        clips.append(rec)
    collections = [{"slug": col["slug"], "name": col["name"].replace("| Moving Image Archive", "").strip(),
                    "clips": sorted(clip_index[i] for i in col["ids"] if i in clip_index)} for col in mia_cols]
    mia = {"generated": time.strftime("%Y-%m-%d"), "source": "movingimagearchive.com", "base": MIA_BASE,
           "sources": sources, "clips": clips, "collections": collections}
    json.dump(mia, open(os.path.join(out, "mia.json"), "w", encoding="utf-8"), separators=(",", ":"), ensure_ascii=False)
    print("mia: sources", len(sources), "clips", len(clips), "collections", len(collections))
