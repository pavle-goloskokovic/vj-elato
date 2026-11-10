import { createBus } from './bus.js';
import { createRenderer } from './gl.js';

const bus = createBus('player');
const els = { A: document.getElementById('deckA'), B: document.getElementById('deckB') };
const canvas = document.getElementById('gl');
const black = document.getElementById('black');
const overlay = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');

export const DEFAULT_PARAMS = {
  opacity: 1, speed: 1, loop: true, fit: 'contain', blend: 'normal',
  hue: 0, saturate: 1, contrast: 1, brightness: 1, invert: 0, blur: 0,
  // WebGL only
  zoom: 1, rotate: 0, pixelate: 0, rgbShift: 0, posterize: 0, threshold: 0, mirror: 0, kaleido: 0,
};
export const DEFAULT_MASTER = {
  crossfade: 0, blackout: false, feedback: 0, fbZoom: 1, fbRotate: 0, fbHue: 0, strobe: 0, scale: 0.75,
};

const state = {
  decks: {
    A: { params: { ...DEFAULT_PARAMS }, meta: null, objectUrl: null, error: null, in: 0, out: null, mode: 'css', wantGl: false },
    B: { params: { ...DEFAULT_PARAMS }, meta: null, objectUrl: null, error: null, in: 0, out: null, mode: 'css', wantGl: false },
  },
  master: { ...DEFAULT_MASTER },
  controllerSeen: 0,
  fps: 0,
};

const renderer = createRenderer(canvas);
if (!renderer) console.warn('WebGL2 unavailable; running CSS-only');

// Hosts known to send CORS headers on their video files, so WebGL may read them.
// archive.org is NOT one: its redirect carries Access-Control-Allow-Origin but the
// storage node that serves the bytes does not, so a crossorigin request fails outright.
// Streams therefore play as CSS layers; local files (blob:) get the full WebGL path.
const CORS_HOSTS = [];
function canUseGl(source) {
  if (!renderer) return false;
  if (source.kind === 'file') return true;
  try {
    const u = new URL(source.url, location.href);
    if (u.origin === location.origin) return true;
    return CORS_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

// ---------- CSS layer (fallback for non-CORS streams) ----------
function applyDeckCss(name) {
  const v = els[name], d = state.decks[name], p = d.params;
  const x = state.master.crossfade;
  const mix = name === 'A' ? Math.min(1, 2 * (1 - x)) : Math.min(1, 2 * x);
  if (d.mode === 'gl') {
    v.style.opacity = 0;             // drawn by the canvas; keep the element alive and playing
    v.style.filter = 'none';
  } else {
    v.style.opacity = (p.opacity * mix).toFixed(3);
    v.style.filter = [
      p.hue ? `hue-rotate(${p.hue}deg)` : '',
      p.saturate !== 1 ? `saturate(${p.saturate})` : '',
      p.contrast !== 1 ? `contrast(${p.contrast})` : '',
      p.brightness !== 1 ? `brightness(${p.brightness})` : '',
      p.invert ? `invert(${p.invert})` : '',
      p.blur ? `blur(${p.blur}px)` : '',
    ].filter(Boolean).join(' ') || 'none';
    v.style.transform = `scale(${p.zoom || 1}) rotate(${p.rotate || 0}deg)`;
  }
  v.playbackRate = p.speed;
  v.loop = p.loop && !d.out;
  v.classList.toggle('cover', p.fit === 'cover');
  if (name === 'B') v.style.mixBlendMode = p.blend === 'add' ? 'plus-lighter' : p.blend;
  // when A is on the canvas and B is a CSS layer on top, or the reverse, the
  // canvas itself carries B's blend mode so the two still mix
  canvas.style.mixBlendMode = (state.decks.A.mode === 'css' && state.decks.B.mode === 'gl') ? (state.decks.B.params.blend === 'add' ? 'plus-lighter' : state.decks.B.params.blend) : 'normal';
}
function applyMaster() {
  black.style.opacity = state.master.blackout ? 1 : 0;
  applyDeckCss('A'); applyDeckCss('B');
  fitCanvas();
}

function load(name, source, meta) {
  const d = state.decks[name], v = els[name];
  if (d.objectUrl) { URL.revokeObjectURL(d.objectUrl); d.objectUrl = null; }
  d.error = null; d.meta = meta || null;
  d.in = (meta && meta.in) || 0; d.out = (meta && meta.out) || null;
  d.wantGl = canUseGl(source);
  d.mode = d.wantGl ? 'gl' : 'css';
  v.pause();
  v.removeAttribute('src');
  if (d.wantGl && source.kind === 'url') v.crossOrigin = 'anonymous'; else v.removeAttribute('crossorigin');
  if (source.kind === 'file') {
    d.objectUrl = URL.createObjectURL(source.file);
    v.src = d.objectUrl;
  } else {
    v.src = source.url;
  }
  v.load();
  v.currentTime = d.in;
  const p = v.play();
  if (p) p.catch((e) => { if (e.name !== 'AbortError') d.error = e.message; });
  applyDeckCss(name);
}

// in/out loop
setInterval(() => {
  for (const name of ['A', 'B']) {
    const d = state.decks[name], v = els[name];
    if (d.out && v.currentTime >= d.out) {
      if (d.params.loop) v.currentTime = d.in; else v.pause();
    }
  }
}, 40);

// ---------- render loop ----------
function fitCanvas() {
  if (!renderer) return;
  const scale = state.master.scale || 1;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.resize(window.innerWidth * dpr * scale, window.innerHeight * dpr * scale);
}
window.addEventListener('resize', fitCanvas);

let frames = 0, fpsAt = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  if (!renderer) return;
  const decks = {};
  let anyGl = false;
  for (const name of ['A', 'B']) {
    const d = state.decks[name], v = els[name];
    let active = false;
    if (d.mode === 'gl' && v.readyState >= 2) {
      if (renderer.upload(name, v)) active = true;
      else { d.mode = 'css'; d.error = null; applyDeckCss(name); }   // tainted: fall back
    }
    anyGl = anyGl || d.mode === 'gl';
    decks[name] = { params: d.params, active };
  }
  if (anyGl) renderer.render(decks, state.master, now / 1000);
  else renderer.clear();
  frames++;
  if (now - fpsAt > 1000) { state.fps = Math.round(frames * 1000 / (now - fpsAt)); frames = 0; fpsAt = now; }
}
requestAnimationFrame(frame);

// ---------- status ----------
function status() {
  const decks = {};
  for (const name of ['A', 'B']) {
    const d = state.decks[name], v = els[name];
    decks[name] = {
      time: v.currentTime, duration: isFinite(v.duration) ? v.duration : null,
      paused: v.paused, ready: v.readyState >= 2, error: d.error, mode: d.mode,
      title: d.meta ? d.meta.title : null,
    };
  }
  bus.send('status', { decks, fullscreen: !!document.fullscreenElement, fps: state.fps, gpu: renderer ? renderer.info : null });
}
setInterval(status, 250);

for (const name of ['A', 'B']) {
  els[name].addEventListener('error', () => {
    const e = els[name].error;
    state.decks[name].error = e ? `media error ${e.code}${e.message ? ': ' + e.message : ''}` : 'media error';
  });
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
bus.on('deck', (m) => { Object.assign(state.decks[m.deck].params, m.params); applyDeckCss(m.deck); });
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
