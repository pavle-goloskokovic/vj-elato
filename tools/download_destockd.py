"""Download Destockd clips listed in a catalog file to a local folder (USB stick).

usage: python -I download_destockd.py <catalog.json> <dest_root> [--pause 0.5] [--only slug,slug]

catalog.json is vj/catalog-scan/destockd_collections.json ({"clips": {url: {film, shot, keyframe,
collections, bytes}}}). Clips land in <dest_root>/destockd/<film>/<shot>.mp4, keyframes next to them
as <shot>.jpg, and <dest_root>/destockd-index.json lists what is on the stick with sizes and tags.
Re-running skips complete files and resumes partial ones. Downloads are serial with a pause between
clips to stay gentle on the host.
"""
import json, os, re, subprocess, sys, time

def safe_name(s):
    s = re.sub(r'[<>:"/\|?*\x00-\x1f]', "_", s).strip(" .")
    return s[:120] or "_"

def curl_download(url, path, expected):
    tmp = path + ".part"
    for attempt in range(4):
        r = subprocess.run(["curl", "-sS", "-L", "--retry", "2", "--max-time", "900",
                            "-C", "-", "-o", tmp, url], capture_output=True, text=True)
        size = os.path.getsize(tmp) if os.path.exists(tmp) else 0
        if r.returncode == 0 and (expected is None or size == expected):
            os.replace(tmp, path); return size, None
        if expected is not None and size > expected:          # corrupt partial, start over
            os.remove(tmp)
        time.sleep(3 * (attempt + 1))
    return None, (r.stderr.strip() or f"size {size} != {expected}")

def main():
    args = sys.argv[1:]
    pause = 0.5; only = None
    if "--pause" in args: i = args.index("--pause"); pause = float(args[i+1]); del args[i:i+2]
    if "--only" in args: i = args.index("--only"); only = set(args[i+1].split(",")); del args[i:i+2]
    catalog, dest = args
    clips = json.load(open(catalog, encoding="utf-8"))["clips"]
    index_path = os.path.join(dest, "destockd-index.json")
    index = json.load(open(index_path, encoding="utf-8")) if os.path.exists(index_path) else {"clips": {}}
    todo = [(u, r) for u, r in clips.items() if not only or set(r["collections"]) & only]
    total = sum(r["bytes"] or 0 for _, r in todo)
    print(f"{len(todo)} clips, {total/1e9:.2f} GB -> {dest}", flush=True)
    done_bytes = 0; failed = []
    for n, (url, r) in enumerate(todo, 1):
        rel_dir = os.path.join("destockd", safe_name(r["film"]))
        os.makedirs(os.path.join(dest, rel_dir), exist_ok=True)
        rel = os.path.join(rel_dir, r["shot"] + ".mp4"); path = os.path.join(dest, rel)
        expected = r["bytes"]
        if os.path.exists(path) and (expected is None or os.path.getsize(path) == expected):
            status = "skip"
        else:
            size, err = curl_download(url, path, expected)
            if err: failed.append((url, err)); print(f"[{n}/{len(todo)}] FAIL {rel}: {err}", flush=True); continue
            status = "ok"
            time.sleep(pause)
        kf = os.path.join(dest, rel_dir, r["shot"] + ".jpg")
        if not os.path.exists(kf) and r.get("keyframe"):
            subprocess.run(["curl", "-sS", "-L", "--max-time", "60", "-o", kf, "https://destockd.com" + r["keyframe"]], capture_output=True)
        done_bytes += expected or 0
        index["clips"][url] = {"path": rel.replace("\\", "/"), "film": r["film"], "shot": r["shot"],
                               "bytes": expected, "collections": r["collections"],
                               "keyframe": (rel_dir + "/" + r["shot"] + ".jpg").replace("\\", "/")}
        if status == "ok" or n % 25 == 0:
            print(f"[{n}/{len(todo)}] {status} {done_bytes/1e9:.2f}/{total/1e9:.2f} GB  {rel}", flush=True)
        if n % 10 == 0:
            json.dump(index, open(index_path, "w", encoding="utf-8"), indent=1)
    index["generated"] = time.strftime("%Y-%m-%dT%H:%M:%S"); index["source"] = "destockd.com collections"
    json.dump(index, open(index_path, "w", encoding="utf-8"), indent=1)
    print(f"done: {len(index['clips'])} clips on stick, {len(failed)} failed", flush=True)
    for u, e in failed: print("  FAILED", u, e)

if __name__ == "__main__":
    main()
