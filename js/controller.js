import { createBus } from './bus.js';
import { loadCatalogs, destockdAll, destockdCollection, spelunkrAll, fmtBytes, fmtTime } from './catalog.js';
import { supportsFolders, pickFolder, restoreFolder, requestAccess, scanFolder, getFile } from './library.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const bus = createBus('controller');

const DEFAULT_PARAMS = {
  opacity: 1, speed: 1, loop: true, hue: 0, saturate: 1, contrast: 1, brightness: 1,
  invert: 0, blur: 0, blend: 'normal', fit: 'contain',
};
const state = {
  decks: {
    A: { clip: null, source: null, params: { ...DEFAULT_PARAMS }, playing: false },
    B: { clip: null, source: null, params: { ...DEFAULT_PARAMS }, playing: false },
  },
  master: { crossfade: 0, blackout: false },
  catalogs: null,
  library: null,          // { name, index, byUrl, files, handle }
  tab: 'destockd',
  lastStatus: 0,
};

// ---------- player link ----------
const playerPill = $('#player-status');
bus.on('hello', () => sendSync());
bus.on('status', (m) => {
  state.lastStatus = Date.now();
  for (const name of ['A', 'B']) updateDeckStatus(name, m.decks[name]);
});
// The controller pings and the player answers with its status. Message handlers are not
// throttled in background tabs the way timers are, so this stays live even if the
// player tab is hidden.
setInterval(() => bus.send('ping'), 500);
setInterval(() => {
  const on = Date.now() - state.lastStatus < 2000;
  playerPill.textContent = on ? 'player connected' : 'no player';
  playerPill.className = 'pill ' + (on ? 'on' : 'off');
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

// ---------- decks ----------
async function loadClip(name, clip) {
  const d = state.decks[name];
  let source;
  const local = clip.local || (state.library && clip.url && state.library.byUrl.get(clip.url));
  if (local) {
    try {
      const file = await getFile(local);
      source = { kind: 'file', file };
    } catch (e) {
      console.warn('local file failed, falling back to URL', e);
    }
  }
  if (!source) {
    if (!clip.url) { alert('This clip is not available on the stick and has no URL.'); return; }
    source = { kind: 'url', url: clip.url };
  }
  d.clip = clip; d.source = source; d.playing = true;
  bus.send('load', { deck: name, source, meta: clipMeta(clip) });
  const deckEl = $(`.deck[data-deck=${name}]`);
  $('.title', deckEl).textContent = clip.title;
  $('.preview img', deckEl).src = clip.thumb || '';
  $('.badge', deckEl).textContent = source.kind === 'file' ? 'stick' : 'stream';
  $('.badge', deckEl).className = 'badge';
}

function updateDeckStatus(name, s) {
  if (!s) return;
  const deckEl = $(`.deck[data-deck=${name}]`);
  $('.t', deckEl).textContent = fmtTime(s.time);
  $('.d', deckEl).textContent = fmtTime(s.duration);
  const scrub = $('.scrub', deckEl);
  if (!scrub.matches(':active') && s.duration) scrub.value = Math.round((s.time / s.duration) * 1000);
  const badge = $('.badge', deckEl);
  if (s.error) { badge.textContent = s.error; badge.className = 'badge error'; }
  else if (state.decks[name].clip) {
    badge.className = 'badge';
    badge.textContent = (state.decks[name].source.kind === 'file' ? 'stick' : 'stream') + (s.paused ? ' · paused' : s.ready ? '' : ' · buffering');
  }
}

for (const deckEl of $$('.deck')) {
  const name = deckEl.dataset.deck;
  for (const btn of $$('[data-cmd]', deckEl)) {
    btn.addEventListener('click', () => {
      bus.send(btn.dataset.cmd, { deck: name });
      if (btn.dataset.cmd !== 'pause') state.decks[name].playing = true; else state.decks[name].playing = false;
    });
  }
  for (const input of $$('[data-param]', deckEl)) {
    const param = input.dataset.param;
    const out = input.nextElementSibling && input.nextElementSibling.tagName === 'OUTPUT' ? input.nextElementSibling : null;
    const read = () => input.type === 'checkbox' ? input.checked : input.tagName === 'SELECT' ? input.value : parseFloat(input.value);
    const show = () => { if (out) out.value = typeof read() === 'number' ? (Number.isInteger(parseFloat(input.step)) ? read() : read().toFixed(2)) : ''; };
    input.addEventListener('input', () => { show(); setParam(name, param, read()); });
    input.addEventListener('change', () => { show(); setParam(name, param, read()); });
    show();
  }
  $('.reset', deckEl).addEventListener('click', () => {
    for (const input of $$('[data-param]', deckEl)) {
      const param = input.dataset.param;
      if (['loop', 'fit', 'blend'].includes(param)) continue;
      input.value = DEFAULT_PARAMS[param];
      input.dispatchEvent(new Event('input'));
    }
  });
  const scrub = $('.scrub', deckEl);
  const seek = () => {
    const dur = parseDur($('.d', deckEl).textContent);
    if (dur) bus.send('seek', { deck: name, time: (scrub.value / 1000) * dur });
  };
  scrub.addEventListener('input', seek);
}
function setParam(name, param, value) {
  state.decks[name].params[param] = value;
  bus.send('deck', { deck: name, params: { [param]: value } });
}
function parseDur(txt) {
  const p = txt.split(':').map(Number);
  if (p.some(isNaN)) return 0;
  return p.reduce((a, b) => a * 60 + b, 0);
}

// ---------- master ----------
const crossfade = $('#crossfade');
crossfade.addEventListener('input', () => setMaster('crossfade', parseFloat(crossfade.value)));
$('#blackout').addEventListener('change', (e) => setMaster('blackout', e.target.checked));
function setMaster(k, v) { state.master[k] = v; bus.send('master', { params: { [k]: v } }); }

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=search], input[type=url]')) return;
  if (e.key === '1') toggleDeck('A');
  if (e.key === '2') toggleDeck('B');
  if (e.key === 'b' || e.key === 'B') { $('#blackout').checked = !$('#blackout').checked; setMaster('blackout', $('#blackout').checked); }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (e.target.matches('input[type=range]')) return;
    const v = Math.min(1, Math.max(0, parseFloat(crossfade.value) + (e.key === 'ArrowRight' ? 0.05 : -0.05)));
    crossfade.value = v; setMaster('crossfade', v); e.preventDefault();
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
  // A plain file on the stick. If the index knows it, show the Destockd keyframe.
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

// URL tab
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
    const handle = await pickFolder();
    await useFolder(handle);
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
