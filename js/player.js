import { createBus } from './bus.js';
import { Stage } from './stage.js';
import { createLog } from './log.js';

const log = createLog('player');

const bus = createBus('player');
const canvas = document.getElementById('gl');
const black = document.getElementById('black');
const overlay = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');

const stage = new Stage({
  videos: { A: document.getElementById('deckA'), B: document.getElementById('deckB') },
  canvas,
  onEvent: (e) => {
    if (e.type === 'loadfail') log.error('deck.loadfail', `deck ${e.deck}: ${e.why}`, { title: e.meta && e.meta.title, url: e.meta && e.meta.url });
    else if (e.type === 'error') log.error('deck.error', `deck ${e.deck}: ${e.why}`);
    else if (e.type === 'loaded') log.info('deck.loaded', `deck ${e.deck}: ${e.meta && e.meta.title}`);
  },
  layout: (st) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
    const s = st.master.scale || 1;
    return { canvas: [w, h], fbo: [w * s, h * s], panes: { out: [0, 0, w, h] } };
  },
});
window.addEventListener('resize', () => stage.relayout());
if (!stage.renderer) { console.warn('WebGL2 unavailable; running CSS-only'); log.warn('player.webgl', 'WebGL2 unavailable, CSS only'); }
else log.info('player.gpu', stage.info || 'webgl2');

let controllerSeen = 0;
function applyBlackout() { black.style.opacity = stage.master.blackout ? 1 : 0; }

// ---------- messages ----------
function status() {
  bus.send('status', { ...stage.status(), fullscreen: !!document.fullscreenElement });
}
setInterval(status, 250);

bus.on('*', () => { controllerSeen = Date.now(); overlay.classList.add('hidden'); });
bus.on('load', (m) => { log.info('deck.load', `deck ${m.deck} <- ${m.meta && m.meta.title}`, { kind: m.source.kind, via: m.source.via }); stage.load(m.deck, m.source, m.meta); });
// low frame rate for a while is worth a line
let lowSince = 0;
setInterval(() => {
  if (!stage.renderer) return;
  if (stage.fps && stage.fps < 20) { lowSince = lowSince || Date.now(); if (Date.now() - lowSince > 5000) { log.warn('player.fps', `${stage.fps} fps`, { gpu: stage.info }); lowSince = Date.now(); } }
  else lowSince = 0;
}, 2000);
bus.on('log?', () => bus.send('log', { entries: log.entries() }));
bus.on('play', (m) => stage.play(m.deck));
bus.on('pause', (m) => stage.pause(m.deck));
bus.on('restart', (m) => stage.restart(m.deck));
bus.on('seek', (m) => stage.seek(m.deck, m.time));
bus.on('deck', (m) => stage.setParams(m.deck, m.params));
bus.on('master', (m) => { stage.setMaster(m.params); applyBlackout(); });
bus.on('sync', (m) => {
  for (const name of ['A', 'B']) {
    const s = m.decks[name];
    if (!s) continue;
    stage.setParams(name, s.params || {});
    if (s.source) stage.load(name, s.source, { ...s.meta, time: s.time, paused: s.playing === false });
  }
  stage.setMaster(m.master || {});
  applyBlackout();
});
bus.on('ping', () => status());
bus.on('state?', () => { bus.send('state', stage.status()); });

setInterval(() => {
  if (Date.now() - controllerSeen > 3000 && !document.fullscreenElement) {
    overlayMsg.textContent = controllerSeen
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
  if (e.key === 'b' || e.key === 'B') { stage.setMaster({ blackout: !stage.master.blackout }); applyBlackout(); }
});
let cursorTimer;
document.addEventListener('mousemove', () => {
  document.body.classList.add('show-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.remove('show-cursor'), 2000);
});

// A fresh player asks the controller for everything; the controller answers with a sync.
bus.send('hello');
