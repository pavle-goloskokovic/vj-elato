// Local clip library, from one of two places:
//
//   - the local server (tools/serve.py), when the pages are served by it: GET stick/index
//     lists the stick's clips, thumbnails, Destockd index, collections and cache, and every
//     file is a same-origin URL under stick/. No permission prompts, any browser.
//   - a folder picked with the File System Access API (Chrome, Edge), for the web version.
//     The handle is kept in IndexedDB so the next session only needs one click.
//
// Both produce the same library shape:
//   { name, server, writable, index, byUrl, byPath, files, thumbs, folders, collections, own }
//   files: [{ path, name, folder, bytes?, handle? | url?, film?, shot?, tags?, cached? }]
//   byUrl: Map clip URL -> file (from destockd-index.json and the proxy cache)
//   folders / collections: Map name -> [paths]; own: { name: [paths] } (vj-elato-collections.json)

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

// ---------- shared assembly ----------
function assemble(name, files, thumbs, index, own, cacheEntries, extra) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const folders = new Map();
  for (const f of files) { if (f.folder) { if (!folders.has(f.folder)) folders.set(f.folder, []); folders.get(f.folder).push(f.path); } }
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
  for (const e of cacheEntries || []) {
    const f = byPath.get(e.file);
    if (f) { byUrl.set(e.url, f); f.cached = true; if (e.title) f.title = e.title; }
  }
  return { name, index, byUrl, byPath, files, thumbs, folders, collections, own: own || {}, ...extra };
}

// ---------- the server's stick ----------
export async function scanServer() {
  const r = await fetch(new URL('stick/index', location.href), { cache: 'no-store' });
  if (!r.ok) throw new Error(`stick/index ${r.status}`);
  const d = await r.json();
  const fileUrl = (p) => new URL('stick/' + p.split('/').map(encodeURIComponent).join('/'), location.href).href;
  const files = d.files.map((f) => ({ path: f.path, name: f.name, folder: f.folder, bytes: f.bytes, url: fileUrl(f.path) }));
  const thumbs = new Map();
  for (const f of d.files) if (f.thumb) thumbs.set(f.path, { path: f.thumb, url: fileUrl(f.thumb) });
  return assemble(d.root, files, thumbs, d.index, d.own, d.cache, { server: true, writable: !!d.writable });
}

// ---------- a picked folder ----------
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

async function canWrite(handle) {
  try { return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch { return false; }
}

async function readJson(dir, name) {
  try {
    const f = await (await dir.getFileHandle(name)).getFile();
    return JSON.parse(await f.text());
  } catch { return null; }
}

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
  const index = await readJson(root, 'destockd-index.json');
  let cacheEntries = [];
  try {
    const cacheIdx = await readJson(await root.getDirectoryHandle('cache'), 'index.json');
    cacheEntries = Object.values((cacheIdx && cacheIdx.entries) || {}).filter((e) => e.complete).map((e) => ({ url: e.url, file: 'cache/' + e.file, title: e.title }));
  } catch { /* no cache folder */ }
  const ownFile = await readJson(root, COLLECTIONS_FILE);
  return assemble(root.name, files, thumbs, index, (ownFile && ownFile.collections) || {}, cacheEntries, { server: false, handle: root, writable: await canWrite(root) });
}

export async function saveCollections(lib, own) {
  if (lib.server) {
    const r = await fetch(new URL('stick/collections', location.href), { method: 'POST', body: JSON.stringify({ collections: own }) });
    const d = await r.json();
    if (!d.saved) throw new Error(d.error || 'server could not write');
    return;
  }
  const fh = await lib.handle.getFileHandle(COLLECTIONS_FILE, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify({ collections: own, saved: new Date().toISOString() }, null, 1));
  await w.close();
}

export async function getFile(entry) {
  return entry.handle.getFile();
}

// ---------- thumbnails ----------
const urlCache = new Map();        // path -> URL

// Resolves to an image URL for a local clip: the sibling image if there is one, otherwise
// a frame grabbed from the video and cached in IndexedDB.
export async function localThumb(lib, entry) {
  if (urlCache.has(entry.path)) return urlCache.get(entry.path);
  const img = lib.thumbs.get(entry.path);
  if (img && img.url) { urlCache.set(entry.path, img.url); return img.url; }
  let blob = null;
  if (img && img.handle) {
    try { blob = await img.handle.getFile(); } catch { /* ignore */ }
  }
  if (!blob) {
    const key = `thumb:${entry.path}:${entry.bytes || (entry.handle ? (await entry.handle.getFile()).size : 0)}`;
    blob = await kvGet(key);
    if (!blob) {
      blob = await grabFrame(entry.url || URL.createObjectURL(await entry.handle.getFile()), !entry.url);
      if (blob) kvSet(key, blob).catch(() => {});
    }
  }
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  urlCache.set(entry.path, url);
  return url;
}

let grabQueue = Promise.resolve();
function grabFrame(src, revoke) {
  // one at a time: each grab decodes a video
  const job = grabQueue.then(() => new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const done = (blob) => { if (revoke) URL.revokeObjectURL(src); v.removeAttribute('src'); resolve(blob); };
    const timer = setTimeout(() => done(null), 10000);
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
    v.src = src;
  }));
  grabQueue = job.catch(() => {});
  return job;
}
