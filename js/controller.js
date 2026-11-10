import { createBus } from './bus.js';
import { loadCatalogs, destockdAll, destockdCollection, spelunkrAll, fmtBytes, fmtTime } from './catalog.js';
import { supportsFolders, pickFolder, restoreFolder, requestAccess, scanFolder, getFile } from './library.js';
import { Stage, DEFAULT_PARAMS, DEFAULT_MASTER } from './stage.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const bus = createBus('controller');
const KEEP_ON_RESET = new Set(['loop', 'fit', 'blend', 'opacity', 'speed', 'crossfade', 'blackout', 'scale']);
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

function readInput(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.tagName === 'SELECT') return isNaN(Number(input.value)) ? input.value : Number(input.value);
  return parseFloat(input.value);
}
function showOutput(input) {
  const out = input.parentElement.querySelector('output');
  if (!out) return;
  const v = readInput(input);
  if (typeof v !== 'number') { out.value = ''; return; }
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
  if (input.type === 'checkbox') input.checked = !!value; else input.value = value;
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
    if (KEEP_ON_RESET.has(key)) continue;
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
    $('img', paneEls[name]).src = d.clip && d.clip.thumb ? d.clip.thumb : '';
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
    badge.textContent = (d.source && d.source.kind === 'file' ? 'stick' : 'stream') + (s.paused ? ' · paused' : s.ready ? '' : ' · buffering');
  } else badge.textContent = '';
  $('.mode', el).textContent = d.clip ? (s.mode === 'gl' ? 'webgl' : 'css only') : '';
  $('.mode', el).title = s.mode === 'gl' ? 'All effects available' : 'This source does not allow WebGL to read it (no CORS). Only the basic filters apply.';
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
const clipMeta = (c) => ({ key: c.key, title: c.title, thumb: c.thumb || '', url: c.url || null, localPath: c.local ? c.local.path : (c.localPath || null), in: c.in || 0, out: c.out || null, source: c.source });
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
  if (clip.url) return { kind: 'url', url: clip.url };
  return null;
}

async function loadClip(name, clip) {
  const d = state.decks[name];
  const source = await resolveSource(clip);
  if (!source) { alert('This clip is not on the stick (or the folder is not connected) and has no URL.'); return; }
  d.clip = clip; d.source = source; d.playing = true; d.duration = 0; d.noSeek = false; d.seekAt = 0;
  bus.send('load', { deck: name, source, meta: clipMeta(clip) });
  if (state.live) preview.load(name, source, clipMeta(clip));
  $('.title', deckEls[name]).textContent = clip.title;
  $('img', paneEls[name]).src = clip.thumb || '';
  const badge = $('.badge', paneEls[name]);
  badge.textContent = source.kind === 'file' ? 'stick' : 'stream'; badge.className = 'badge';
  persist();
}

// After a restore: feed the preview stage, and the player where it needs it.
// A clip that was reachable only as a stream (folder not yet reconnected)
// is upgraded to its stick file once the folder is back, so the WebGL
// effects return; the player is moved to the file at its current time.
async function loadPreviews(syncPlayer) {
  let changed = false;
  for (const name of ['A', 'B']) {
    const d = state.decks[name];
    if (!d.clip) continue;
    const hadStream = d.source && d.source.kind === 'url';
    if (!d.source || (hadStream && state.library)) {
      const src = await resolveSource(d.clip);
      if (!src || (hadStream && src.kind === 'url')) continue;      // nothing new
      d.source = src; d.noSeek = false; d.seekAt = 0; changed = true;
      if (hadStream && state.playerHasState) bus.send('load', { deck: name, source: src, meta: { ...clipMeta(d.clip), time: d.lastTime || 0, paused: !d.playing } });
    }
    if (d.source && state.live) preview.load(name, d.source, { ...clipMeta(d.clip), time: d.lastTime || 0, paused: !d.playing });
    $('.badge', paneEls[name]).textContent = d.source.kind === 'file' ? 'stick' : 'stream';
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
    for (const file of state.library.files) {
      if (!terms.length || match(file.path.toLowerCase())) out.push(localClip(file));
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
  const idx = state.library.index && Object.values(state.library.index.clips).find((r) => r.path === file.path);
  return {
    key: 'local:' + file.path, source: 'stick', title: file.path, local: file, localPath: file.path,
    thumb: idx ? `${state.catalogs.destockd.keyframeBase}${encodeURIComponent(idx.film)}/${idx.shot}.jpg` : '',
    sub: idx ? idx.collections.join(', ') : '',
  };
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
  const isLocal = !!(c.local || (state.library && c.url && state.library.byUrl.has(c.url)));
  const sub = c.source === 'spelunkr'
    ? `${c.channelName}${c.year ? ' · ' + c.year : ''} · ${fmtTime(c.duration)}${c.bytes ? ' · ' + fmtBytes(c.bytes) : ''}`
    : c.source === 'destockd' ? `${c.shot}${c.bytes ? ' · ' + fmtBytes(c.bytes) : ''}` : (c.sub || '');
  el.innerHTML = `
    <img loading="lazy" src="${c.thumb || ''}" alt="">
    ${isLocal ? '<span class="local">stick</span>' : ''}
    <div class="actions"><button data-deck="A">A</button><button data-deck="B">B</button></div>
    <div class="meta"><div class="name">${escapeHtml(c.source === 'destockd' ? c.film : c.title)}</div><div class="sub">${escapeHtml(sub)}</div></div>`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-deck]');
    loadClip(b ? b.dataset.deck : $('#target-deck').value, c);
  });
  return el;
}

$('#url-load').addEventListener('click', () => {
  const url = $('#url-input').value.trim();
  if (!url) return;
  loadClip($('#target-deck').value, { key: 'url:' + url, source: 'url', title: url.split('/').pop() || url, url, thumb: '' });
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
  state.library = { ...lib, handle, byPath: new Map(lib.files.map((f) => [f.path, f])) };
  folderStatus.textContent = `${lib.name}: ${lib.files.length} files${lib.byUrl.size ? `, ${lib.byUrl.size} matched to Destockd` : ''}`;
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
