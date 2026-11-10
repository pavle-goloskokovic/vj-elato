import { createBus } from './bus.js';

const bus = createBus('player');
const els = { A: document.getElementById('deckA'), B: document.getElementById('deckB') };
const black = document.getElementById('black');
const overlay = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');

const DEFAULT_PARAMS = {
  opacity: 1, speed: 1, loop: true, hue: 0, saturate: 1, contrast: 1, brightness: 1,
  invert: 0, blur: 0, blend: 'normal', fit: 'contain',
};
const state = {
  decks: {
    A: { params: { ...DEFAULT_PARAMS }, meta: null, objectUrl: null, error: null, in: 0, out: null },
    B: { params: { ...DEFAULT_PARAMS }, meta: null, objectUrl: null, error: null, in: 0, out: null },
  },
  master: { crossfade: 0, blackout: false },
  controllerSeen: 0,
};

// ---------- rendering ----------
function applyDeck(name) {
  const v = els[name], p = state.decks[name].params;
  const x = state.master.crossfade;                      // 0 = A, 1 = B
  const mix = name === 'A' ? Math.min(1, 2 * (1 - x)) : Math.min(1, 2 * x);
  v.style.opacity = (p.opacity * mix).toFixed(3);
  v.style.filter = [
    p.hue ? `hue-rotate(${p.hue}deg)` : '',
    p.saturate !== 1 ? `saturate(${p.saturate})` : '',
    p.contrast !== 1 ? `contrast(${p.contrast})` : '',
    p.brightness !== 1 ? `brightness(${p.brightness})` : '',
    p.invert ? `invert(${p.invert})` : '',
    p.blur ? `blur(${p.blur}px)` : '',
  ].filter(Boolean).join(' ') || 'none';
  v.playbackRate = p.speed;
  v.loop = p.loop && !state.decks[name].out;              // in/out loops are handled in tick()
  v.classList.toggle('cover', p.fit === 'cover');
  if (name === 'B') v.style.mixBlendMode = p.blend;
}
function applyMaster() {
  black.style.opacity = state.master.blackout ? 1 : 0;
  applyDeck('A'); applyDeck('B');
}

function load(name, source, meta) {
  const d = state.decks[name], v = els[name];
  if (d.objectUrl) { URL.revokeObjectURL(d.objectUrl); d.objectUrl = null; }
  d.error = null; d.meta = meta || null;
  d.in = (meta && meta.in) || 0; d.out = (meta && meta.out) || null;
  if (source.kind === 'file') {
    d.objectUrl = URL.createObjectURL(source.file);
    v.src = d.objectUrl;
  } else {
    v.src = source.url;
  }
  v.currentTime = d.in;
  const p = v.play();
  if (p) p.catch((e) => { d.error = e.message; });
  applyDeck(name);
}

// in/out loop and heartbeat
function tick() {
  for (const name of ['A', 'B']) {
    const d = state.decks[name], v = els[name];
    if (d.out && v.currentTime >= d.out) {
      if (d.params.loop) v.currentTime = d.in; else v.pause();
    }
  }
}
setInterval(tick, 40);

function status() {
  const decks = {};
  for (const name of ['A', 'B']) {
    const d = state.decks[name], v = els[name];
    decks[name] = {
      time: v.currentTime, duration: isFinite(v.duration) ? v.duration : null,
      paused: v.paused, ready: v.readyState >= 2, error: d.error,
      title: d.meta ? d.meta.title : null, buffered: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0,
    };
  }
  bus.send('status', { decks, fullscreen: !!document.fullscreenElement });
}
setInterval(status, 250);

for (const name of ['A', 'B']) {
  els[name].addEventListener('error', () => {
    const e = els[name].error;
    state.decks[name].error = e ? `media error ${e.code}${e.message ? ': ' + e.message : ''}` : 'media error';
  });
  els[name].addEventListener('ended', () => { /* loop handled by element or tick */ });
}

// ---------- messages ----------
function sawController() {
  state.controllerSeen = Date.now();
  overlay.classList.add('hidden');
}
bus.on('*', sawController);
bus.on('load', (m) => load(m.deck, m.source, m.meta));
bus.on('play', (m) => { const p = els[m.deck].play(); if (p) p.catch(() => {}); });
bus.on('pause', (m) => els[m.deck].pause());
bus.on('restart', (m) => { els[m.deck].currentTime = state.decks[m.deck].in; const p = els[m.deck].play(); if (p) p.catch(() => {}); });
bus.on('seek', (m) => { els[m.deck].currentTime = m.time; });
bus.on('deck', (m) => { Object.assign(state.decks[m.deck].params, m.params); applyDeck(m.deck); });
bus.on('master', (m) => { Object.assign(state.master, m.params); applyMaster(); });
bus.on('sync', (m) => {
  for (const name of ['A', 'B']) {
    const s = m.decks[name];
    if (!s) continue;
    Object.assign(state.decks[name].params, s.params || {});
    if (s.source) load(name, s.source, s.meta);
    if (s.playing === false) els[name].pause();
  }
  Object.assign(state.master, m.master || {});
  applyMaster();
});
bus.on('ping', () => status());

setInterval(() => {
  if (Date.now() - state.controllerSeen > 3000 && !document.fullscreenElement) {
    overlayMsg.textContent = state.controllerSeen
      ? 'Controller tab went quiet. Reopen controller.html in this browser.'
      : 'Waiting for a controller. Open controller.html in another tab of this browser.';
    overlay.classList.remove('hidden');
  }
}, 1000);

// ---------- local interaction ----------
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
overlay.addEventListener('click', toggleFullscreen);
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  if (e.key === 'h' || e.key === 'H') overlay.classList.toggle('hidden');
  if (e.key === 'b' || e.key === 'B') { state.master.blackout = !state.master.blackout; applyMaster(); }
});
let cursorTimer;
document.addEventListener('mousemove', () => {
  document.body.classList.add('show-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.remove('show-cursor'), 2000);
});

applyMaster();
bus.send('hello');
