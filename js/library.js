// Local clip library: a folder (USB stick) picked with the File System Access
// API. The handle is kept in IndexedDB so the next session only needs one
// click to re-grant access.
//
// What the scan finds on the folder:
//   - every video file, with a sibling image of the same name as its thumbnail
//     (tools/download_destockd.py writes shot_004.jpg next to shot_004.mp4)
//   - destockd-index.json, if present: maps clip URLs to paths and carries the
//     Destockd collection tags, so catalog entries resolve to local files
//   - vj-elato-collections.json, if present: your own named lists of paths,
//     which the controller can also write (star button) when the folder was
//     opened with write access
//   - the top-level folders, which double as collections

const DB = 'vj-elato', STORE = 'kv', KEY = 'library-folder';
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
export const COLLECTIONS_FILE = 'vj-elato-collections.json';

export const supportsFolders = () => 'showDirectoryPicker' in window;

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function kvGet(k) {
  const d = await db();
  return new Promise((res, rej) => {
    const r = d.transaction(STORE).objectStore(STORE).get(k);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
export async function kvSet(k, v) {
  const d = await db();
  return new Promise((res, rej) => {
    const r = d.transaction(STORE, 'readwrite').objectStore(STORE).put(v, k);
    r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  });
}

export async function pickFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'vj-elato-clips', mode: 'readwrite' });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    handle = await window.showDirectoryPicker({ id: 'vj-elato-clips' });   // read-only fallback
  }
  await kvSet(KEY, handle);
  return handle;
}

export async function restoreFolder() {
  try {
    const handle = await kvGet(KEY);
    if (!handle) return null;
    const perm = await handle.queryPermission({ mode: 'read' });
    return { handle, granted: perm === 'granted' };
  } catch { return null; }
}

export async function requestAccess(handle) {
  try { if ((await handle.requestPermission({ mode: 'readwrite' })) === 'granted') return true; } catch { /* fall through */ }
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

export async function canWrite(handle) {
  try { return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch { return false; }
}

async function readJson(dir, name) {
  try {
    const f = await (await dir.getFileHandle(name)).getFile();
    return JSON.parse(await f.text());
  } catch { return null; }
}

// Returns { name, index, byUrl, byPath, files, thumbs, folders, collections, own, writable }
//   files:       [{ path, name, handle, folder }]   every video file
//   thumbs:      Map video path -> image file entry
//   byUrl:       Map clip URL -> video entry        (from destockd-index.json)
//   byPath:      Map path -> video entry
//   folders:     Map top-level folder -> [paths]
//   collections: Map tag -> [paths]                 (Destockd tags from the index)
//   own:         { name: [paths] }                  (vj-elato-collections.json)
export async function scanFolder(root) {
  const files = [], images = new Map();
  async function walk(dir, prefix) {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.') || name === 'System Volume Information' || name === 'vj-elato') continue;
      if (h.kind === 'directory') await walk(h, prefix + name + '/');
      else if (VIDEO_EXT.test(name)) files.push({ path: prefix + name, name, handle: h, folder: prefix.split('/')[0] || '' });
      else if (IMAGE_EXT.test(name)) images.set(prefix + name.replace(IMAGE_EXT, ''), { path: prefix + name, handle: h });
    }
  }
  await walk(root, '');
  files.sort((a, b) => a.path.localeCompare(b.path));

  const thumbs = new Map();
  for (const f of files) {
    const img = images.get(f.path.replace(VIDEO_EXT, ''));
    if (img) thumbs.set(f.path, img);
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const folders = new Map();
  for (const f of files) { if (f.folder) { if (!folders.has(f.folder)) folders.set(f.folder, []); folders.get(f.folder).push(f.path); } }

  const index = await readJson(root, 'destockd-index.json');
  const byUrl = new Map(), collections = new Map();
  if (index && index.clips) {
    for (const [url, rec] of Object.entries(index.clips)) {
      const f = byPath.get(rec.path);
      if (!f) continue;
      byUrl.set(url, f);
      f.film = rec.film; f.shot = rec.shot; f.tags = rec.collections || [];
      for (const c of f.tags) { if (!collections.has(c)) collections.set(c, []); collections.get(c).push(f.path); }
    }
  }
  const ownFile = await readJson(root, COLLECTIONS_FILE);
  const own = (ownFile && ownFile.collections) || {};
  return { name: root.name, index, byUrl, byPath, files, thumbs, folders, collections, own, writable: await canWrite(root) };
}

export async function saveCollections(root, own) {
  const fh = await root.getFileHandle(COLLECTIONS_FILE, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify({ collections: own, saved: new Date().toISOString() }, null, 1));
  await w.close();
}

export async function getFile(entry) {
  return entry.handle.getFile();
}

// ---------- thumbnails ----------
const urlCache = new Map();        // path -> object URL

// Resolves to an image URL for a local clip: the sibling image if there is
// one, otherwise a frame grabbed from the video and cached in IndexedDB.
export async function localThumb(lib, entry) {
  if (urlCache.has(entry.path)) return urlCache.get(entry.path);
  let blob = null;
  const img = lib.thumbs.get(entry.path);
  if (img) {
    try { blob = await img.handle.getFile(); } catch { /* ignore */ }
  }
  if (!blob) {
    const file = await entry.handle.getFile();
    const key = `thumb:${entry.path}:${file.size}:${file.lastModified}`;
    blob = await kvGet(key);
    if (!blob) {
      blob = await grabFrame(file);
      if (blob) kvSet(key, blob).catch(() => {});
    }
  }
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  urlCache.set(entry.path, url);
  return url;
}

let grabQueue = Promise.resolve();
function grabFrame(file) {
  // one at a time: each grab decodes a video
  const job = grabQueue.then(() => new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const url = URL.createObjectURL(file);
    const done = (blob) => { URL.revokeObjectURL(url); v.removeAttribute('src'); resolve(blob); };
    const timer = setTimeout(() => done(null), 8000);
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(1, v.duration * 0.1); });
    v.addEventListener('seeked', () => {
      const c = document.createElement('canvas');
      const w = 320, h = Math.round(320 * (v.videoHeight || 9) / (v.videoWidth || 16));
      c.width = w; c.height = h;
      try { c.getContext('2d').drawImage(v, 0, 0, w, h); } catch { clearTimeout(timer); return done(null); }
      clearTimeout(timer);
      c.toBlob((b) => done(b), 'image/jpeg', 0.8);
    }, { once: true });
    v.addEventListener('error', () => { clearTimeout(timer); done(null); });
    v.src = url;
  }));
  grabQueue = job.catch(() => {});
  return job;
}
