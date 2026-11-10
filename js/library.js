// Local clip library: a folder (USB stick) picked with the File System Access
// API. The handle is kept in IndexedDB so the next session only needs one
// click to re-grant access. If the folder holds a destockd-index.json written
// by tools/download_destockd.py, clips are matched to catalog entries by URL;
// every other video file is listed as a plain local clip.

const DB = 'vj-elato', STORE = 'kv', KEY = 'library-folder';
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv)$/i;

export const supportsFolders = () => 'showDirectoryPicker' in window;

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kvGet(k) {
  const d = await db();
  return new Promise((res, rej) => {
    const r = d.transaction(STORE).objectStore(STORE).get(k);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kvSet(k, v) {
  const d = await db();
  return new Promise((res, rej) => {
    const r = d.transaction(STORE, 'readwrite').objectStore(STORE).put(v, k);
    r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  });
}

export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ id: 'vj-elato-clips', mode: 'read' });
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
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

// Walks the folder. Returns { name, index, byUrl, files }.
//   index: parsed destockd-index.json or null
//   byUrl: Map clipUrl -> { path, handle }   (from the index, only files that exist)
//   files: [{ path, name, handle }]            every video file found
export async function scanFolder(root) {
  const files = [];
  async function walk(dir, prefix) {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.') || name === 'System Volume Information') continue;
      if (h.kind === 'directory') await walk(h, prefix + name + '/');
      else if (VIDEO_EXT.test(name)) files.push({ path: prefix + name, name, handle: h });
    }
  }
  await walk(root, '');
  files.sort((a, b) => a.path.localeCompare(b.path));

  let index = null;
  try {
    const f = await (await root.getFileHandle('destockd-index.json')).getFile();
    index = JSON.parse(await f.text());
  } catch { /* no index on this folder */ }

  const byPath = new Map(files.map((f) => [f.path, f]));
  const byUrl = new Map();
  if (index && index.clips) {
    for (const [url, rec] of Object.entries(index.clips)) {
      const f = byPath.get(rec.path);
      if (f) byUrl.set(url, f);
    }
  }
  return { name: root.name, index, byUrl, files };
}

export async function getFile(entry) {
  return entry.handle.getFile();
}
