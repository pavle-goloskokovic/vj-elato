import json, subprocess, time, sys
def get(url):
    r = subprocess.run(["curl","-s","--max-time","40",url], capture_output=True); return json.loads(r.stdout)
def head_len(url):
    r = subprocess.run(["curl","-sI","--max-time","30",url], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if line.lower().startswith("content-length:"): return int(line.split(":")[1])
    return None
cols = get("https://destockd.com/api/collections")["collections"]
clips = {}   # clip url -> record
for c in cols:
    page = 1
    while True:
        d = get(f"https://destockd.com/api/collections/{c['slug']}?page={page}")
        for s in d.get("results", []):
            rec = clips.setdefault(s["clip"], {"film": s["film"], "shot": s["shot"], "keyframe": s["keyframe"], "collections": []})
            rec["collections"].append(c["slug"])
        if not d.get("has_more") and len(d.get("results", [])) < 1: break
        if not d.get("has_more"): break
        page += 1; time.sleep(0.1)
    print(c["slug"], "pages", page, file=sys.stderr, flush=True)
print("unique clips across collections:", len(clips))
for i, (u, rec) in enumerate(clips.items()):
    rec["bytes"] = head_len(u); time.sleep(0.12)
    if i % 100 == 0: print(i, file=sys.stderr, flush=True)
json.dump({"collections": cols, "clips": clips}, open("destockd_collections.json", "w"), indent=0)
sizes = [r["bytes"] for r in clips.values() if r["bytes"]]
tot = sum(sizes)
print(f"sized: {len(sizes)}  total: {tot/1e9:.2f} GB  mean {tot/len(sizes)/1e6:.1f} MB  median {sorted(sizes)[len(sizes)//2]/1e6:.1f} MB")
per = {}
for r in clips.values():
    for c in r["collections"]: per.setdefault(c, [0,0]); per[c][0]+=1; per[c][1]+= r["bytes"] or 0
for c,(n,b) in sorted(per.items(), key=lambda x:-x[1][1]): print(f"{c:14s} {n:4d} clips {b/1e9:5.2f} GB")
multi = sum(1 for r in clips.values() if len(r["collections"])>1); print("clips in >1 collection:", multi)
