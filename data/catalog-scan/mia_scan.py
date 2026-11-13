"""Scan movingimagearchive.com: every clip via its listing API, plus the curated collections.

usage: python -I mia_scan.py            writes mia_clips.json and mia_collections.json here

The listing API pages 100 clips at a time; collection pages embed their clip records in the
HTML. Requests go one at a time with a pause; a clip record has id, source slug/title/year,
start/end seconds, video and thumbnail URL, colour mode and aspect ratio.
"""
import json, re, subprocess, sys, time, html

BASE = "https://www.movingimagearchive.com"
PAUSE = 0.3
EXTRA = {}          # clip records seen on collection pages

def get(url, data=None):
    cmd = ["curl", "-s", "--max-time", "60", "-L", url]
    if data is not None: cmd += ["-X", "POST", "-H", "Content-Type: application/json", "-d", json.dumps(data)]
    r = subprocess.run(cmd, capture_output=True)
    return r.stdout

def listing():
    clips, offset, pages = {}, 0, 0
    while True:
        d = json.loads(get(f"{BASE}/api/clips?color=all&aspectRatio=all&offset={offset}"))
        batch = d.get("clips") or []
        before = len(clips)
        for c in batch: clips[c["id"]] = c
        pages += 1; offset += len(batch)
        if pages % 10 == 0: print(f"  {offset} clips so far ({len(clips)} unique)", file=sys.stderr, flush=True)
        if not batch or not d.get("hasMore"): break
        if len(clips) == before:                       # the API repeats itself past some offset: stop
            print(f"  no new clips at offset {offset}, stopping", file=sys.stderr, flush=True); break
        if offset > 200000: break
        time.sleep(PAUSE)
    return clips

def collections():
    page = get(f"{BASE}/collections").decode("utf-8", "replace")
    slugs = sorted(set(re.findall(r'href="/collection/([a-z0-9-]+)"', page)))
    out = []
    for slug in slugs:
        h = get(f"{BASE}/collection/{slug}").decode("utf-8", "replace")
        name = re.search(r"<title>([^<|]+)", h)
        # the page embeds full clip records (escaped JSON); keep them, the listing API stops at 10k
        recs = {}
        # the records sit inside JS string literals (self.__next_f.push([1,"..."])): unescape each
        # literal as a JSON string, then pick the clip objects out of the plain text
        for lit in re.findall(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)', h):
            try: text = json.loads('"' + lit + '"')
            except Exception: continue
            for obj in re.findall(r'\{"id":"[0-9a-f-]{36}","sourceId".*?"aspectRatio":"[^"]*"\}', text):
                try: rec = json.loads(obj); recs[rec["id"]] = rec
                except Exception: pass
        ids = sorted(recs)
        EXTRA.update(recs)
        out.append({"slug": slug, "name": html.unescape(name.group(1).strip()) if name else slug, "ids": ids})
        print(f"  collection {slug}: {len(ids)} clips", file=sys.stderr, flush=True)
        time.sleep(PAUSE)
    return out

if __name__ == "__main__":
    if "--collections-only" in sys.argv:
        clips = json.load(open("mia_clips.json", encoding="utf-8"))
    else:
        clips = listing()
    print(f"listing: {len(clips)} clips", file=sys.stderr)
    cols = collections()
    added = sum(1 for k in EXTRA if k not in clips)
    clips.update(EXTRA)
    print(f"collection pages added {added} clips not in the listing", file=sys.stderr)
    missing = [i for c in cols for i in c["ids"] if i not in clips]
    print(f"collections: {len(cols)}, clips referenced: {sum(len(c['ids']) for c in cols)}, not in listing: {len(missing)}", file=sys.stderr)
    json.dump(clips, open("mia_clips.json", "w", encoding="utf-8"), ensure_ascii=False)
    json.dump(cols, open("mia_collections.json", "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    same_thumb = sum(1 for c in clips.values() if c.get("thumbnailUrl") == c["videoUrl"].replace("/clips/", "/thumbnails/").rsplit(".", 1)[0] + ".jpg")
    print(f"thumbnail derivable from video url: {same_thumb} of {len(clips)}", file=sys.stderr)
    srcs = {c["sourceSlug"] for c in clips.values()}
    print(f"sources: {len(srcs)}; duration total {sum(c.get('durationSeconds') or 0 for c in clips.values())/3600:.1f} h", file=sys.stderr)
