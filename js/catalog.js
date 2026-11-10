// Loads the compact catalogs built by tools/build_catalog.py and turns entries
// into playable URLs. Every clip gets a stable `key` so playlists and the stick
// index can refer to it regardless of where it is played from.

export async function loadCatalogs(base = './catalog/') {
  const [destockd, spelunkr] = await Promise.all([
    fetch(base + 'destockd.json').then((r) => r.json()),
    fetch(base + 'spelunkr.json').then((r) => r.json()),
  ]);
  return { destockd, spelunkr };
}

export const shotName = (n) => 'shot_' + String(n).padStart(3, '0');

export function destockdClip(cat, filmIndex, shot, bytes) {
  const film = cat.films[filmIndex];
  const s = shotName(shot);
  return {
    key: `destockd:${film.n}/${s}`,
    source: 'destockd',
    title: `${film.n} · ${s}`,
    film: film.n,
    shot: s,
    url: `${cat.clipBase}${film.p}/${s}.mp4`,
    thumb: `${cat.keyframeBase}${film.p}/${s}.jpg`,
    bytes: bytes || null,
    archive: `https://archive.org/details/${film.ia}`,
  };
}

export function* destockdAll(cat) {
  for (let i = 0; i < cat.films.length; i++) {
    for (const n of cat.films[i].shots) yield destockdClip(cat, i, n);
  }
}

export function destockdCollection(cat, slug) {
  const col = cat.collections.find((c) => c.slug === slug);
  if (!col) return [];
  return col.clips.map(([fi, n, b]) => ({ ...destockdClip(cat, fi, n, b), collection: slug }));
}

export function spelunkrItem(cat, channel, item) {
  const file = item.f.includes('%') ? item.f : encodeURIComponent(item.f);
  return {
    key: `ia:${item.id}/${item.f}`,
    source: 'spelunkr',
    title: item.t || item.f,
    channel: channel.id,
    channelName: channel.name,
    year: item.y || null,
    duration: item.d || null,
    in: item.in || 0,
    out: item.out || null,
    url: `${cat.base}${item.id}/${file}`,
    thumb: `${cat.thumbBase}${item.id}`,
    bytes: item.b || null,
    archive: `https://archive.org/details/${item.id}`,
  };
}

export function* spelunkrAll(cat) {
  for (const ch of cat.channels) for (const it of ch.items) yield spelunkrItem(cat, ch, it);
}

export function fmtBytes(b) {
  if (!b) return '';
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.round(b / 1e3) + ' KB';
}

export function fmtTime(s) {
  if (s == null || !isFinite(s)) return '–:––';
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}
