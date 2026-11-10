import { createBus } from './bus.js';
import { loadCatalogs, destockdAll, destockdCollection, spelunkrAll, fmtBytes, fmtTime } from './catalog.js';
import { supportsFolders, pickFolder, restoreFolder, requestAccess, scanFolder, getFile } from './library.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const bus = createBus('controller');

// Must match DEFAULT_PARAMS / DEFAULT_MASTER in player.js
const DEFAULT_PARAMS = {
  opacity: 1, speed: 1, loop: true, fit: 'contain', blend: 'normal',
  hue: 0, saturate: 1, contrast: 1, brightness: 1, invert: 0, blur: 0,
  zoom: 1, rotate: 0, pixelate: 0, rgbShift: 0, posterize: 0, threshold: 0, mirror: 0, kaleido: 0,
};
const DEFAULT_MASTER = {
  crossfade: 0, blackout: false, feedback: 0, fbZoom: 1, fbRotate: 0, fbHue: 0, strobe: 0, scale: 0.75,
};
const KEEP_ON_RESET = new Set(['loop', 'fit', 'blend', 'opacity', 'speed', 'crossfade', 'blackout', 'scale']);

const state = {
  decks: {
    A: { clip: null, source: null, params: { ...DEFAULT_PARAMS }, playing: false },
    B: { clip: null, source: null, params: { ...DEFAULT_PARAMS }, playing: false },
  },
  master: { ...DEFAULT_MASTER },
  catalogs: null,
  library: null,          // { name, index, byUrl, files, handle }
  tab: 'destockd',
  lastStatus: 0,
};

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

// Generic parameter binding: inputs with data-param (deck) or data-master.
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
  for (const btn of $$('[data-cmd]', el)) {
    btn.addEventListener('click', () => {
      bus.send(btn.dataset.cmd, { deck: name });
      state.decks[name].playing = btn.dataset.cmd !== 'pause';
    });
  }
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
    if (dur) bus.send('seek', { deck: name, time: (scrub.value / 1000) * dur });
  });
}
function setParam(name, key, value) {
  state.decks[name].params[key] = value;
  bus.send('deck', { deck: name, params: { [key]: value } });
}

bindInputs(document, 'data-master', (key, value) => setMaster(key, value));
function setMaster(key, value) {
  state.master[key] = value;
  bus.send('master', { params: { [key]: value } });
}
$('#master-reset').addEventListener('click', () => {
  for (const input of $$('.master-params [data-master]')) {
    const key = input.dataset.master;
    if (KEEP_ON_RESET.has(key)) continue;
    setInput(input, DEFAULT_MASTER[key]);
    setMaster(key, DEFAULT_MASTER[key]);
  }
});

// ---------- player link ----------
const playerPill = $('#player-status'), gpuStatus = $('#gpu-status');
bus.on('hello', () => sendSync());
bus.on('status', (m) => {
  state.lastStatus = Date.now();
  for (const name of ['A', 'B']) updateDeckStatus(name, m.decks[name]);
  gpuStatus.textContent = m.gpu ? `${m.fps || 0} fps · ${m.gpu.replace(/^ANGLE \((.*)\)$/, '$1').split(',').slice(0, 2).join(',').slice(0, 48)}` : 'no WebGL';
});
// The controller pings and the player answers with its status. Message handlers are not
// throttled in background tabs the way timers are, so this stays live even if the
// player tab is hidden.
setInterval(() => bus.send('ping'), 500);
setInterval(() => {
  const on = Date.now() - state.lastStatus < 2000;
  playerPill.textContent = on ? 'player connected' : 'no player';
  playerPill.className = 'pill ' + (on ? 'on' : 'off');
  if (!on) gpuStatus.textContent = '';
}, 500);

function sendSync() {
  const decks = {};
  for (const name of ['A', 'B']) {
    const d = state.decks[name];
    decks[name] = { params: d.params, source: d.source, meta: d.clip ? clipMeta(d.clip) : null, playing: d.playing };
  }
  bus.send('sync', { decks, master: state.master });
}
const clipMeta = (c) => ({ title: c.title, in: c.in || 0, out: c.out || null, key: c.key });

$('#open-player').addEventListener('click', () => window.open('player.html', 'vj-elato-player'));

// ---------- loading clips ----------
async function loadClip(name, clip) {
  const d = state.decks[name];
  let source;
  const local = clip.local || (state.library && clip.url && state.library.byUrl.get(clip.url));
  if (local) {
    try {
      source = { kind: 'file', file: await getFile(local) };
    } catch (e) {
      console.warn('local file failed, falling back to URL', e);
    }
  }
  if (!source) {
    if (!clip.url) { alert('This clip is not available on the stick and has no URL.'); return; }
    source = { kind: 'url', url: clip.url };
  }
  d.clip = clip; d.source = source; d.playing = true; d.duration = 0;
  bus.send('load', { deck: name, source, meta: clipMeta(clip) });
  const el = deckEls[name];
  $('.title', el).textContent = clip.title;
  $('.preview img', el).src = clip.thumb || '';
  $('.badge', el).textContent = source.kind === 'file' ? 'stick' : 'stream';
  $('.badge', el).className = 'badge';
}

function updateDeckStatus(name, s) {
  if (!s) return;
  const el = deckEls[name], d = state.decks[name];
  d.duration = s.duration || 0;
  $('.t', el).textContent = fmtTime(s.time);
  $('.d', el).textContent = fmtTime(s.duration);
  const scrub = $('.scrub', el);
  if (!scrub.matches(':active') && s.duration) scrub.value = Math.round((s.time / s.duration) * 1000);
  const badge = $('.badge', el);
  if (s.error) { badge.textContent = s.error; badge.className = 'badge error'; }
  else if (d.clip) {
    badge.className = 'badge';
    badge.textContent = (d.source.kind === 'file' ? 'stick' : 'stream') + (s.paused ? ' · paused' : s.ready ? '' : ' · buffering');
  }
  $('.mode', el).textContent = d.clip ? (s.mode === 'gl' ? 'webgl' : 'css only') : '';
  $('.mode', el).title = s.mode === 'gl' ? 'All effects available' : 'This source does not allow WebGL to read it (no CORS). Only the basic filters apply.';
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
function toggleDeck(name) {
  const d = state.decks[name];
  d.playing = !d.playing;
  bus.send(d.playing ? 'play' : 'pause', { deck: name });
}

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
    key: 'local:' + file.path, source: 'stick', title: file.path, local: file,
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
  state.library = { ...lib, handle };
  folderStatus.textContent = `${lib.name}: ${lib.files.length} files${lib.byUrl.size ? `, ${lib.byUrl.size} matched to Destockd` : ''}`;
  fillFilter(); render();
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
  restoreLibrary();
  bus.send('ping');
})();
