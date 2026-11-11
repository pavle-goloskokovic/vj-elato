import { createBus } from './bus.js';
import { loadCatalogs, destockdAll, destockdCollection, spelunkrAll, fmtBytes, fmtTime } from './catalog.js';
import { supportsFolders, pickFolder, restoreFolder, requestAccess, scanFolder, getFile, localThumb, saveCollections, COLLECTIONS_FILE } from './library.js';
import { Stage, DEFAULT_PARAMS, DEFAULT_MASTER } from './stage.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const bus = createBus('controller');
// "reset fx" on a deck puts every control back except loop and fit; on the master it
// leaves the crossfader, blackout and render size alone.
const KEEP_ON_RESET = new Set(['loop', 'fit']);
const KEEP_ON_MASTER_RESET = new Set(['crossfade', 'blackout', 'scale']);
const STORE_KEY = 'vj-elato-controller';

const state = {
  decks: {
    A: { clip: null, source: null, params: { ...DEFAULT_PARAMS }, playing: false, duration: 0 },
    B: { clip: null, source: null, params: { ...DEFAULT_PARAMS }, playing: false, duration: 0 },
  },
  master: { ...DEFAULT_MASTER },
  live: true,
  catalogs: null,
  library: null,          // { name, index, byUrl, byPath, files, handle }
  tab: 'destockd',
  lastStatus: 0,
  playerHasState: false,  // true once a live player has told us what it holds
  playerNeedsSync: false, // we synced a player while some clip's file was not yet reachable
  proxy: null,            // info from the local server's /proxy/info, when we run from it
};

// ---------- live preview stage ----------
const strip = $('#preview-strip');
const paneEls = { A: $('.pane[data-pane=A]', strip), out: $('.pane[data-pane=out]', strip), B: $('.pane[data-pane=B]', strip) };
const preview = new Stage({
  videos: { A: $('#pvA'), B: $('#pvB') },
  canvas: $('#preview-gl'),
  layout: () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const sr = strip.getBoundingClientRect();
    const rect = (el) => { const r = el.getBoundingClientRect(); return [Math.round((r.left - sr.left) * dpr), Math.round((r.top - sr.top) * dpr), Math.round(r.width * dpr), Math.round(r.height * dpr)]; };
    const out = rect(paneEls.out);
    // CSS-mode videos sit exactly over the output pane
    for (const v of [$('#pvA'), $('#pvB')]) {
      const r = paneEls.out.getBoundingClientRect();
      Object.assign(v.style, { left: (r.left - sr.left) + 'px', top: (r.top - sr.top) + 'px', width: r.width + 'px', height: r.height + 'px' });
    }
    return { canvas: [Math.round(sr.width * dpr), Math.round(sr.height * dpr)], fbo: [Math.max(out[2], 320), Math.max(out[3], 180)], panes: { out, A: rect(paneEls.A), B: rect(paneEls.B) } };
  },
});
new ResizeObserver(() => preview.relayout()).observe(strip);
$('#live-preview').addEventListener('change', (e) => { state.live = e.target.checked; preview.setEnabled(state.live); persist(); });

// ---------- deck UI from template ----------
const deckEls = {};
for (const name of ['A', 'B']) {
  const el = $('#deck-template').content.firstElementChild.cloneNode(true);
  el.dataset.deck = name;
  $('.deck-name', el).textContent = name;
  $('.key', el).textContent = name === 'A' ? '1' : '2';
  if (name === 'A') $('.blend-only', el).remove();
  $('#decks').appendChild(el);
  deckEls[name] = el;
}

// A range with data-steps="0,3,4,6" is a stepped slider: its position is an
// index into that list, and data-labels gives the text shown for each step.
const steps = (input) => input.dataset.steps ? input.dataset.steps.split(',').map(Number) : null;
function readInput(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.tagName === 'SELECT') return isNaN(Number(input.value)) ? input.value : Number(input.value);
  const st = steps(input);
  if (st) return st[Math.min(st.length - 1, Math.max(0, Math.round(parseFloat(input.value))))];
  return parseFloat(input.value);
}
function showOutput(input) {
  const out = input.parentElement.querySelector('output');
  if (!out) return;
  const v = readInput(input);
  if (input.dataset.labels) { out.value = input.dataset.labels.split(',')[Math.round(parseFloat(input.value))] ?? String(v); return; }
  if (typeof v !== 'number') { out.value = ''; return; }
  if (input.dataset.unit === '%') { out.value = (v * 100).toFixed(1).replace(/\.0$/, '') + '%'; return; }
  const step = parseFloat(input.step || '1');
  out.value = step >= 1 ? String(v) : step >= 0.1 ? v.toFixed(1) : v.toFixed(2);
}
function bindInputs(root, attr, onChange) {
  for (const input of $$(`[${attr}]`, root)) {
    const key = input.getAttribute(attr);
    const fire = () => { showOutput(input); onChange(key, readInput(input)); };
    input.addEventListener('input', fire);
    input.addEventListener('change', fire);
    showOutput(input);
  }
}
function setInput(input, value) {
  const st = steps(input);
  if (input.type === 'checkbox') input.checked = !!value;
  else if (st) { const i = st.indexOf(Number(value)); input.value = i < 0 ? 0 : i; }
  else input.value = value;
  showOutput(input);
}

for (const name of ['A', 'B']) {
  const el = deckEls[name];
  bindInputs(el, 'data-param', (key, value) => setParam(name, key, value));
  for (const btn of $$('[data-cmd]', el)) btn.addEventListener('click', () => command(btn.dataset.cmd, name));
  $('.reset', el).addEventListener('click', () => {
    for (const input of $$('[data-param]', el)) {
      const key = input.dataset.param;
      if (KEEP_ON_RESET.has(key)) continue;
      setInput(input, DEFAULT_PARAMS[key]);
      setParam(name, key, DEFAULT_PARAMS[key]);
    }
  });
  $('.bars', el).addEventListener('click', () => {
    const input = $('[data-param=cropX]', el);
    const v = state.decks[name].params.cropX ? 0 : 0.125;
    setInput(input, v); setParam(name, 'cropX', v);
  });
  const scrub = $('.scrub', el);
  scrub.addEventListener('input', () => {
    const dur = state.decks[name].duration;
    if (dur) { const t = (scrub.value / 1000) * dur; bus.send('seek', { deck: name, time: t }); preview.seek(name, t); }
  });
}
function command(cmd, name) {
  bus.send(cmd, { deck: name });
  if (cmd === 'play') preview.play(name); else if (cmd === 'pause') preview.pause(name); else if (cmd === 'restart') preview.restart(name);
  state.decks[name].playing = cmd !== 'pause';
  persist();
}
function setParam(name, key, value) {
  state.decks[name].params[key] = value;
  bus.send('deck', { deck: name, params: { [key]: value } });
  preview.setParams(name, { [key]: value });
  persist();
}
function setMaster(key, value) {
  state.master[key] = value;
  bus.send('master', { params: { [key]: value } });
  if (key !== 'scale') preview.setMaster({ [key]: value });   // the preview keeps its own small render size
  persist();
}
bindInputs(document, 'data-master', setMaster);
$('#master-reset').addEventListener('click', () => {
  for (const input of $$('.master-params [data-master]')) {
    const key = input.dataset.master;
    if (KEEP_ON_MASTER_RESET.has(key)) continue;
    setInput(input, DEFAULT_MASTER[key]);
    setMaster(key, DEFAULT_MASTER[key]);
  }
});

// Push the whole state object into the inputs (after a restore).
function syncInputs() {
  for (const name of ['A', 'B']) {
    for (const input of $$('[data-param]', deckEls[name])) setInput(input, state.decks[name].params[input.dataset.param]);
    preview.setParams(name, state.decks[name].params);
    const d = state.decks[name];
    $('.title', deckEls[name]).textContent = d.clip ? d.clip.title : 'empty';
    setPaneThumb(name, d.clip);
  }
  for (const input of $$('[data-master]')) setInput(input, state.master[input.dataset.master]);
  const { scale, ...rest } = state.master; preview.setMaster(rest);
  $('#live-preview').checked = state.live; preview.setEnabled(state.live);
}

// ---------- persistence (survives a controller reload) ----------
const serializeClip = (c) => c && { ...c, local: undefined, localPath: c.local ? c.local.path : c.localPath };
let persistTimer;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const decks = {};
    for (const name of ['A', 'B']) {
      const d = state.decks[name];
      decks[name] = { clip: serializeClip(d.clip), params: d.params, playing: d.playing };
    }
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ decks, master: state.master, live: state.live })); } catch { /* storage blocked */ }
  }, 300);
}
function loadPersisted() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}

// ---------- player link ----------
const playerPill = $('#player-status'), gpuStatus = $('#gpu-status');
bus.on('hello', () => sendSync());
bus.on('status', onStatus);
bus.on('state', (m) => { adoptPlayerState(m); onStatus(m); });
setInterval(() => bus.send('ping'), 500);   // message handlers are not throttled in hidden tabs; timers are
setInterval(() => {
  const on = Date.now() - state.lastStatus < 2000;
  playerPill.textContent = on ? 'player connected' : 'no player';
  playerPill.className = 'pill ' + (on ? 'on' : 'off');
  if (!on) { gpuStatus.textContent = ''; state.playerHasState = false; }
}, 500);

function onStatus(m) {
  state.lastStatus = Date.now();
  for (const name of ['A', 'B']) updateDeckStatus(name, m.decks[name]);
  gpuStatus.textContent = m.gpu ? `${m.fps || 0} fps · ${m.gpu.replace(/^ANGLE \((.*)\)$/, '$1').split(',').slice(0, 2).join(',').slice(0, 48)}` : 'no WebGL';
}

function updateDeckStatus(name, s) {
  if (!s) return;
  const el = deckEls[name], d = state.decks[name];
  d.duration = s.duration || 0;
  d.lastTime = s.time || 0;          // used to resume a reloaded player where it was
  $('.t', el).textContent = fmtTime(s.time);
  $('.d', el).textContent = fmtTime(s.duration);
  const scrub = $('.scrub', el);
  if (!scrub.matches(':active') && s.duration) scrub.value = Math.round((s.time / s.duration) * 1000);
  const badge = $('.badge', paneEls[name]);
  if (s.error) { badge.textContent = s.error; badge.className = 'badge error'; }
  else if (d.clip) {
    badge.className = 'badge';
    badge.textContent = sourceLabel(d.source) + (s.paused ? ' · paused' : s.ready ? '' : ' · buffering');
  } else badge.textContent = '';
  $('.mode', el).textContent = d.clip ? (s.mode === 'gl' ? 'webgl' : 'css only') : '';
  $('.mode', el).title = s.mode === 'gl' ? 'All effects available' : 'This source does not allow WebGL to read it (no CORS). Only the basic filters apply.';
  d.mode = s.mode;
  const anyGl = ['A', 'B'].some((n) => state.decks[n].clip && state.decks[n].mode === 'gl');
  $('#master-hint').classList.toggle('hidden', anyGl || !['A', 'B'].some((n) => state.decks[n].clip));
  syncPreview(name, s);
}

// Keep the preview in step with the player: nudge it when it drifts, but only
// into a range the element can actually seek to, at most every 2 s, and give
// up on a source that answers seeks by jumping to 0 (a host without Range
// support). The preview then simply free-runs from the start.
function syncPreview(name, s) {
  const d = state.decks[name], pv = preview.videos[name];
  if (!state.live || !d.clip || pv.readyState < 1 || !s.ready) return;
  if (s.paused && !pv.paused) pv.pause();
  if (!s.paused && pv.paused && !pv.ended) preview.play(name);
  if (s.paused || pv.seeking || d.noSeek) return;
  const drift = Math.abs(pv.currentTime - s.time);
  const now = Date.now();
  if (d.seekAt && now - d.seekAt < 2000) {
    if (d.seekTarget != null && !d.seekChecked && now - d.seekAt > 600) {
      d.seekChecked = true;
      if (Math.abs(pv.currentTime - d.seekTarget) > 1.5 && pv.currentTime < 0.5) d.noSeek = true;
    }
    return;
  }
  if (drift <= 0.6) return;
  let can = false;
  for (let i = 0; i < pv.seekable.length; i++) if (s.time >= pv.seekable.start(i) && s.time <= pv.seekable.end(i)) can = true;
  if (!can) return;
  d.seekAt = now; d.seekTarget = s.time; d.seekChecked = false;
  pv.currentTime = s.time;
}

// A running player answers 'state?' with what it holds; adopt it rather than
// restarting its clips.
function adoptPlayerState(m) {
  state.playerHasState = true;
  for (const name of ['A', 'B']) {
    const s = m.decks[name];
    if (!s) continue;
    state.decks[name].params = { ...DEFAULT_PARAMS, ...s.params };
    state.decks[name].playing = !s.paused;
    if (s.meta && s.meta.key) {
      state.decks[name].clip = clipFromMeta(s.meta);
      state.decks[name].source = null;
    }
  }
  state.master = { ...DEFAULT_MASTER, ...m.master };
  syncInputs();
  loadPreviews(false);
  persist();
}

function sendSync() {
  const decks = {};
  for (const name of ['A', 'B']) {
    const d = state.decks[name];
    decks[name] = { params: d.params, source: d.source, meta: d.clip ? clipMeta(d.clip) : null, playing: d.playing, time: d.lastTime || preview.videos[name].currentTime || 0 };
  }
  bus.send('sync', { decks, master: state.master });
  state.playerHasState = true;
  state.playerNeedsSync = ['A', 'B'].some((n) => state.decks[n].clip && !state.decks[n].source);
}
const clipMeta = (c) => ({ key: c.key, title: c.title, thumb: c.thumb && !c.thumb.startsWith('blob:') ? c.thumb : '', url: c.url || null, localPath: c.local ? c.local.path : (c.localPath || null), in: c.in || 0, out: c.out || null, source: c.source });
const clipFromMeta = (m) => ({ key: m.key, title: m.title, thumb: m.thumb, url: m.url, localPath: m.localPath, in: m.in, out: m.out, source: m.source });

$('#open-player').addEventListener('click', () => window.open('player.html', 'vj-elato-player'));

// ---------- resolving and loading clips ----------
async function resolveSource(clip) {
  const local = clip.local
    || (state.library && clip.url && state.library.byUrl.get(clip.url))
    || (state.library && clip.localPath && state.library.byPath.get(clip.localPath));
  if (local) {
    try { return { kind: 'file', file: await getFile(local) }; }
    catch (e) { console.warn('local file failed, falling back to URL', e); }
  }
  if (clip.url && state.proxy) return { kind: 'url', url: proxyUrl(clip.url), via: 'proxy' };
  if (clip.youtube) { alert('YouTube needs the local server with yt-dlp (run from the stick).'); return null; }
  if (clip.url) return { kind: 'url', url: clip.url };
  return null;
}
const YT_RE = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?.*v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const proxyUrl = (u) => new URL('proxy?url=' + encodeURIComponent(u), location.href).href;

async function loadClip(name, clip) {
  const d = state.decks[name];
  const source = await resolveSource(clip);
  if (!source) { alert('This clip is not on the stick (or the folder is not connected) and has no URL.'); return; }
  d.clip = clip; d.source = source; d.playing = true; d.duration = 0; d.noSeek = false; d.seekAt = 0;
  bus.send('load', { deck: name, source, meta: clipMeta(clip) });
  if (state.live) preview.load(name, source, clipMeta(clip));
  $('.title', deckEls[name]).textContent = clip.title;
  setPaneThumb(name, clip);
  const badge = $('.badge', paneEls[name]);
  badge.textContent = sourceLabel(source) + stallNote(clip, source); badge.className = 'badge';
  persist();
}
// A proxied stream heavier than half the host's measured throughput may stall: warn on the badge.
function stallNote(clip, source) {
  if (!source || source.via !== 'proxy' || !state.proxy || !state.proxy.speed) return '';
  if (clip.stall) return ' · may stall';
  if (!clip.bytes || !clip.duration) return '';
  const host = (() => { try { const h = new URL(clip.url).hostname; return h.endsWith('archive.org') ? 'archive.org' : h.includes('youtube') ? 'youtube' : h; } catch { return ''; } })();
  const mbps = state.proxy.speed[host];
  if (!mbps) return '';
  return clip.bytes * 8 / clip.duration / 1e6 * 2 > mbps ? ' · may stall' : '';
}
const sourceLabel = (src) => !src ? '' : src.kind === 'file' ? 'stick' : src.via === 'proxy' ? 'proxy' : 'stream';

// After a restore: feed the preview stage, and the player where it needs it.
// A clip that was reachable only as a stream (folder not yet reconnected)
// is upgraded to its stick file once the folder is back, so the WebGL
// effects return; the player is moved to the file at its current time.
async function loadPreviews(syncPlayer) {
  let changed = false;
  for (const name of ['A', 'B']) {
    const d = state.decks[name];
    if (!d.clip) continue;
    const hadStream = d.source && d.source.kind === 'url' && d.source.via !== 'proxy';
    if (!d.source || (hadStream && state.library)) {
      const src = await resolveSource(d.clip);
      if (!src || (hadStream && src.kind === 'url')) continue;      // nothing new
      d.source = src; d.noSeek = false; d.seekAt = 0; changed = true;
      if (hadStream && state.playerHasState) bus.send('load', { deck: name, source: src, meta: { ...clipMeta(d.clip), time: d.lastTime || 0, paused: !d.playing } });
    }
    if (d.source && state.live) preview.load(name, d.source, { ...clipMeta(d.clip), time: d.lastTime || 0, paused: !d.playing });
    $('.badge', paneEls[name]).textContent = sourceLabel(d.source);
    setPaneThumb(name, d.clip);
  }
  if (syncPlayer && changed && state.playerNeedsSync) sendSync();
  updateFolderHint();
}
function updateFolderHint() {
  const waiting = ['A', 'B'].some((n) => { const d = state.decks[n]; return d.clip && (!d.source || (d.source.kind === 'url' && d.clip.localPath)) && !state.library; });
  $('#folder-hint').classList.toggle('hidden', !waiting);
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=search], input[type=url]')) return;
  if (e.key === '1') toggleDeck('A');
  if (e.key === '2') toggleDeck('B');
  if (e.key === 'b' || e.key === 'B') { const cb = $('#blackout'); cb.checked = !cb.checked; setMaster('blackout', cb.checked); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (e.target.matches('input[type=range]')) return;
    const cf = $('#crossfade');
    const v = Math.min(1, Math.max(0, parseFloat(cf.value) + (e.key === 'ArrowRight' ? 0.05 : -0.05)));
    setInput(cf, v); setMaster('crossfade', v); e.preventDefault();
  }
});
function toggleDeck(name) { command(state.decks[name].playing ? 'pause' : 'play', name); }

// ---------- library ----------
const results = $('#results'), search = $('#search'), filter = $('#filter'), count = $('#count');
const tabs = $$('.tabs button');
for (const t of tabs) t.addEventListener('click', () => setTab(t.dataset.tab));
function setTab(tab) {
  state.tab = tab;
  for (const t of tabs) t.classList.toggle('active', t.dataset.tab === tab);
  $('#url-panel').classList.toggle('hidden', tab !== 'url');
  fillFilter();
  render();
}
function fillFilter() {
  filter.innerHTML = '';
  const add = (v, label) => { const o = document.createElement('option'); o.value = v; o.textContent = label; filter.appendChild(o); };
  if (state.tab === 'destockd' && state.catalogs) {
    add('collections', 'All collections (658)');
    for (const c of state.catalogs.destockd.collections) add('col:' + c.slug, `${c.name} (${c.clips.length})`);
    add('all', 'Every shot (39,001)');
    if (state.library && state.library.byUrl.size) add('local', `On stick (${state.library.byUrl.size})`);
  } else if (state.tab === 'spelunkr' && state.catalogs) {
    add('all', 'All channels');
    for (const c of state.catalogs.spelunkr.channels) add('ch:' + c.id, `${c.emoji} ${c.name} (${c.items.length})`);
  } else if (state.tab === 'stick' && state.library) {
    const lib = state.library;
    add('all', `All files (${lib.files.length})`);
    for (const [name, paths] of Object.entries(lib.own)) add('own:' + name, `★ ${name} (${paths.length})`);
    if (!lib.own.Starred) add('own:Starred', '★ Starred (0)');
    for (const [name, paths] of lib.folders) add('folder:' + name, `📁 ${name} (${paths.length})`);
    for (const [name, paths] of lib.collections) add('tag:' + name, `Destockd · ${name} (${paths.length})`);
  } else if (state.tab === 'stick') {
    add('all', 'All files');
  }
  filter.classList.toggle('hidden', state.tab === 'url');
}
search.addEventListener('input', debounce(render, 120));
filter.addEventListener('change', render);

function currentClips() {
  const q = search.value.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const match = (txt) => terms.every((t) => txt.includes(t));
  const out = [];
  const cat = state.catalogs;
  const f = filter.value;
  if (state.tab === 'destockd' && cat) {
    let it;
    if (f === 'all') it = destockdAll(cat.destockd);
    else if (f === 'local') it = localDestockd();
    else if (f && f.startsWith('col:')) it = destockdCollection(cat.destockd, f.slice(4));
    else it = cat.destockd.collections.flatMap((c) => destockdCollection(cat.destockd, c.slug));
    const seen = new Set();
    for (const c of it) {
      if (seen.has(c.key)) continue;
      if (!terms.length || match((c.film + ' ' + c.shot).toLowerCase())) { seen.add(c.key); out.push(c); if (out.length >= 600) break; }
    }
  } else if (state.tab === 'spelunkr' && cat) {
    const chans = f && f.startsWith('ch:') ? cat.spelunkr.channels.filter((c) => c.id === f.slice(3)) : cat.spelunkr.channels;
    for (const c of spelunkrAll({ ...cat.spelunkr, channels: chans })) {
      if (!terms.length || match(`${c.title} ${c.year || ''} ${c.channelName}`.toLowerCase())) { out.push(c); if (out.length >= 600) break; }
    }
  } else if (state.tab === 'stick' && state.library) {
    const lib = state.library;
    let paths = null;
    if (f && f.startsWith('own:')) paths = lib.own[f.slice(4)] || [];
    else if (f && f.startsWith('folder:')) paths = lib.folders.get(f.slice(7)) || [];
    else if (f && f.startsWith('tag:')) paths = lib.collections.get(f.slice(4)) || [];
    const files = paths ? paths.map((p) => lib.byPath.get(p)).filter(Boolean) : lib.files;
    for (const file of files) {
      if (!terms.length || match(`${file.path} ${(file.tags || []).join(' ')}`.toLowerCase())) out.push(localClip(file));
      if (out.length >= 600) break;
    }
  }
  return out;
}
function* localDestockd() {
  const cat = state.catalogs.destockd;
  const byUrl = new Map();
  for (const c of destockdAll(cat)) if (state.library.byUrl.has(c.url)) byUrl.set(c.url, c);
  for (const c of byUrl.values()) yield c;
}
function localClip(file) {
  return {
    key: 'local:' + file.path, source: 'stick', title: file.film ? `${file.film} · ${file.shot}` : file.path, local: file, localPath: file.path,
    thumb: '',          // resolved from the stick by thumbFor()
    sub: file.tags && file.tags.length ? file.tags.join(', ') : (file.folder || ''),
  };
}

// The local file entry behind a clip, if the stick has it.
function localEntry(c) {
  if (c.local) return c.local;
  const lib = state.library;
  if (!lib) return null;
  return (c.url && lib.byUrl.get(c.url)) || (c.localPath && lib.byPath.get(c.localPath)) || null;
}
// Thumbnail URL for a clip: from the stick when the clip is there (works
// offline), else the catalog's hotlinked image.
async function thumbFor(c) {
  const e = localEntry(c);
  if (e) { try { const u = await localThumb(state.library, e); if (u) return u; } catch { /* fall through */ } }
  return c.thumb && !c.thumb.startsWith('blob:') ? c.thumb : '';
}
function setPaneThumb(name, c) {
  const img = $('img', paneEls[name]);
  img.src = '';
  if (c) thumbFor(c).then((u) => { if (state.decks[name].clip === c) img.src = u; });
}

// ---------- own collections on the stick (vj-elato-collections.json) ----------
function inOwn(name, path) { return !!(state.library && state.library.own[name] && state.library.own[name].includes(path)); }
async function toggleOwn(name, path) {
  const lib = state.library;
  if (!lib) return;
  const list = lib.own[name] || (lib.own[name] = []);
  const i = list.indexOf(path);
  if (i >= 0) list.splice(i, 1); else list.push(path);
  try {
    await saveCollections(lib.handle, lib.own);
  } catch (e) {
    if (!state.warnedWrite) { state.warnedWrite = true; alert(`Could not write ${COLLECTIONS_FILE} on the stick (${e.message}). Reconnect the folder and allow editing, or the collection is kept only for this session.`); }
  }
  fillFilter();
}

function render() {
  const clips = currentClips();
  count.textContent = state.tab === 'url' ? '' : `${clips.length}${clips.length >= 600 ? '+' : ''}`;
  results.innerHTML = '';
  if (state.tab === 'stick' && !state.library) {
    results.innerHTML = `<div class="notice">${supportsFolders() ? 'Pick your clip folder with the button above. The browser remembers it.' : 'This browser cannot open folders. Use Chrome or Edge for the stick library; URL sources still work.'}</div>`;
    return;
  }
  if (!clips.length) { results.innerHTML = '<div class="notice">Nothing matches.</div>'; return; }
  const frag = document.createDocumentFragment();
  for (const c of clips) frag.appendChild(card(c));
  results.appendChild(frag);
}
function card(c) {
  const el = document.createElement('div');
  el.className = 'card';
  const local = localEntry(c);
  const sub = c.source === 'spelunkr'
    ? `${c.channelName}${c.year ? ' · ' + c.year : ''} · ${fmtTime(c.duration)}${c.bytes ? ' · ' + fmtBytes(c.bytes) : ''}`
    : c.source === 'destockd' ? `${c.shot}${c.bytes ? ' · ' + fmtBytes(c.bytes) : ''}` : (c.sub || '');
  const starred = local && inOwn('Starred', local.path);
  el.innerHTML = `
    <img loading="lazy" src="${local ? '' : (c.thumb || '')}" alt="">
    ${local ? '<span class="local">stick</span>' : ''}
    <div class="actions">${local ? `<button class="star${starred ? ' on' : ''}" title="Starred collection on the stick">★</button>` : ''}<button data-deck="A">A</button><button data-deck="B">B</button></div>
    <div class="meta"><div class="name">${escapeHtml(c.source === 'destockd' ? c.film : c.title)}</div><div class="sub">${escapeHtml(sub)}</div></div>`;
  if (local) {
    const img = $('img', el);
    // stick thumbnails are loaded when the card scrolls into view
    thumbObserver.observe(img);
    img._load = () => thumbFor(c).then((u) => { if (u) img.src = u; });
  }
  el.addEventListener('click', async (e) => {
    const star = e.target.closest('button.star');
    if (star) { await toggleOwn('Starred', local.path); star.classList.toggle('on', inOwn('Starred', local.path)); return; }
    const b = e.target.closest('button[data-deck]');
    loadClip(b ? b.dataset.deck : $('#target-deck').value, c);
  });
  return el;
}
const thumbObserver = new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting && en.target._load) { thumbObserver.unobserve(en.target); en.target._load(); en.target._load = null; }
}, { root: results, rootMargin: '300px' });

$('#url-load').addEventListener('click', async () => {
  const url = $('#url-input').value.trim();
  if (!url) return;
  const yt = YT_RE.exec(url);
  if (!yt) { loadClip($('#target-deck').value, { key: 'url:' + url, source: 'url', title: url.split('/').pop() || url, url, thumb: '' }); return; }
  // YouTube: the local proxy resolves it with yt-dlp; ask for the title and thumbnail first
  const status = $('#url-status');
  if (!state.proxy || !state.proxy.youtube) { status.textContent = 'YouTube needs the local server with yt-dlp (run from the stick).'; return; }
  status.textContent = 'resolving with yt-dlp…';
  try {
    const r = await fetch(new URL('proxy/resolve?url=' + encodeURIComponent(url), location.href));
    const info = await r.json();
    if (info.error) { status.textContent = 'YouTube: ' + info.error; return; }
    status.textContent = `${info.title} · ${info.height}p${info.fps > 30 ? info.fps : ''}${info.speedMbps ? ` · link ${info.speedMbps} Mbps` : ''}${info.stall ? ' · may stall, lowest rendition' : ''}`;
    loadClip($('#target-deck').value, { key: 'yt:' + info.id, source: 'youtube', youtube: true, title: info.title, url: info.key, thumb: info.thumbnail || '', duration: info.duration, bytes: info.tbr && info.duration ? info.tbr * 125 * info.duration : null, stall: info.stall });
  } catch (e) { status.textContent = 'YouTube: ' + e.message; }
});

// ---------- clip folder ----------
const folderStatus = $('#folder-status');
$('#pick-folder').addEventListener('click', async () => {
  if (!supportsFolders()) { alert('Folder access needs Chrome or Edge.'); return; }
  try {
    await useFolder(await pickFolder());
  } catch (e) { if (e.name !== 'AbortError') console.error(e); }
});
async function useFolder(handle) {
  folderStatus.textContent = 'scanning…';
  const lib = await scanFolder(handle);
  state.library = { ...lib, handle };
  folderStatus.textContent = `${lib.name}: ${lib.files.length} clips${lib.byUrl.size ? `, ${lib.byUrl.size} Destockd` : ''}, ${lib.thumbs.size} thumbs${lib.writable ? '' : ', read-only'}`;
  fillFilter(); render();
  await loadPreviews(true);     // clips waiting on the stick can now be resolved
}
async function restoreLibrary() {
  if (!supportsFolders()) return;
  const r = await restoreFolder();
  if (!r) return;
  if (r.granted) { await useFolder(r.handle); return; }
  folderStatus.innerHTML = '';
  const b = document.createElement('button');
  b.textContent = `Reconnect "${r.handle.name}"`;
  b.addEventListener('click', async () => { if (await requestAccess(r.handle)) await useFolder(r.handle); });
  folderStatus.appendChild(b);
}

// ---------- local proxy (only when served by tools/serve.py) ----------
const proxyBox = $('#proxy-status');
async function probeProxy() {
  // only a local server can carry the proxy; skip the probe (and its 404) on GitHub Pages
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) { state.proxy = null; renderProxy(); return; }
  try {
    const r = await fetch(new URL('proxy/info', location.href), { cache: 'no-store' });
    const info = r.ok ? await r.json() : null;
    state.proxy = info && info.proxy ? info : null;
  } catch { state.proxy = null; }
  renderProxy();
  if (state.proxy) setInterval(refreshProxy, 10000);
}
async function refreshProxy() {
  try { const r = await fetch(new URL('proxy/info', location.href), { cache: 'no-store' }); if (r.ok) { state.proxy = await r.json(); renderProxy(); } } catch { /* keep last */ }
}
function renderProxy() {
  const p = state.proxy;
  if (!p) { proxyBox.classList.add('hidden'); return; }
  proxyBox.classList.remove('hidden');
  const c = p.cache || {};
  $('#proxy-cache', proxyBox).textContent = (c.enabled ? `cache ${fmtBytes(c.used)} / ${fmtBytes(c.cap)} · ${c.count} clips${c.fetching ? ` · fetching ${c.fetching}` : ''}` : 'cache off') + (p.youtube ? ' · youtube' : '');
  const sp = Object.entries(p.speed || {});
  $('#link-speed', proxyBox).textContent = sp.length ? 'link ' + sp.map(([h, m]) => `${h} ${m} Mbps`).join(' · ') : '';
  $('#link-speed', proxyBox).title = 'Throughput the local server measured from each host; a stream whose bitrate exceeds half of it may stall';
  $('#fetch-on-play', proxyBox).checked = !!p.fetchOnPlay;
}
$('#fetch-on-play').addEventListener('change', async (e) => {
  try { await fetch(new URL('proxy/settings', location.href), { method: 'POST', body: JSON.stringify({ fetchOnPlay: e.target.checked }) }); } catch { /* ignore */ }
  refreshProxy();
});
$('#clear-cache').addEventListener('click', async () => {
  if (!confirm('Delete every clip the proxy cached on the stick?')) return;
  try { await fetch(new URL('proxy/clear', location.href), { method: 'POST' }); } catch { /* ignore */ }
  refreshProxy();
  if (state.library) await useFolder(state.library.handle);
});

// ---------- boot ----------
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

(async () => {
  try {
    state.catalogs = await loadCatalogs();
  } catch (e) {
    results.innerHTML = `<div class="notice">Could not load catalogs: ${escapeHtml(e.message)}. Serve the folder over http, not file://.</div>`;
  }
  setTab('destockd');
  await probeProxy();

  // Restore: prefer what a running player holds; otherwise our last saved state.
  const saved = loadPersisted();
  if (saved) {
    for (const name of ['A', 'B']) {
      const s = saved.decks && saved.decks[name];
      if (!s) continue;
      state.decks[name].params = { ...DEFAULT_PARAMS, ...s.params };
      state.decks[name].playing = !!s.playing;
      state.decks[name].clip = s.clip || null;
    }
    state.master = { ...DEFAULT_MASTER, ...saved.master };
    state.live = saved.live !== false;
  }
  syncInputs();
  bus.send('state?');
  setTimeout(async () => {
    await restoreLibrary();
    if (!state.playerHasState) await loadPreviews(true);
  }, 800);
})();
