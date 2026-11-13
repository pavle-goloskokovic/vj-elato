// Loads the compact catalogs built by tools/build_catalog.py and turns entries
// into playable URLs. Every clip gets a stable `key` so playlists and the stick
// index can refer to it regardless of where it is played from.

export async function loadCatalogs(base = './catalog/') {
  const [destockd, spelunkr, mia] = await Promise.all([
    fetch(base + 'destockd.json').then((r) => r.json()),
    fetch(base + 'spelunkr.json').then((r) => r.json()),
    fetch(base + 'mia.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  return { destockd, spelunkr, mia };
}

// ---------- Moving Image Archive ----------
// clips: [sourceIdx, startMs, endMs, colour, aspect, path]; thumbnail = same path under /thumbnails/ as .jpg
export function miaClip(cat, i) {
  const [si, startMs, endMs, colour, aspect, path, thumbPath] = cat.clips[i];
  const src = cat.sources[si];
  return {
    key: `mia:${path}`,
    source: 'mia',
    title: `${src.title}${src.year ? ' (' + src.year + ')' : ''} · ${fmtTime(startMs / 1000)}`,
    film: src.title, year: src.year, duration: (endMs - startMs) / 1000, colour: !!colour, aspect,
    url: cat.base + path,
    thumb: thumbPath ? (thumbPath.startsWith('http') ? thumbPath : cat.base + thumbPath) : cat.base + path.replace('/clips/', '/thumbnails/').replace(/\.[a-z0-9]+$/, '.jpg'),
  };
}
export function* miaAll(cat) { for (let i = 0; i < cat.clips.length; i++) yield miaClip(cat, i); }
export function miaCollection(cat, slug) {
  const col = cat.collections.find((c) => c.slug === slug);
  return col ? col.clips.map((i) => ({ ...miaClip(cat, i), collection: slug })) : [];
}
// a clip as the site's search API returns it (through the local server)
export function miaFromApi(c) {
  return {
    key: `mia:${c.videoUrl.replace(/^https?:\/\/[^/]+\//, '')}`, source: 'mia',
    title: `${c.sourceTitle}${c.sourceYear ? ' (' + c.sourceYear + ')' : ''} · ${fmtTime(c.startSeconds || 0)}`,
    film: c.sourceTitle, year: c.sourceYear, duration: c.durationSeconds, colour: c.colorMode === 'color', aspect: c.aspectRatio,
    url: c.videoUrl, thumb: c.thumbnailUrl, score: c.score,
  };
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
