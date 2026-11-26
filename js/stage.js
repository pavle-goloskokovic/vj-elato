// A stage is two decks of <video> elements and a canvas that composites them. The
// player owns one filling the window; the controller owns one for its live
// previews. Both run the same code, so what the controller shows is what the
// projector gets.
//
// A deck whose video WebGL may read (local file, same-origin URL) is drawn on
// the canvas with the full effect chain. A deck fed by a stream from a host
// without CORS headers is left as a visible <video> layer with CSS filters:
// video A sits under the canvas, video B above it.
//
// Safe loading: each deck has an active element and a standby one. A new clip
// loads into the standby element while the current clip keeps playing, and the
// two swap only once the new one reports it can play. A clip that fails or
// times out leaves the current picture untouched and reports the error, so a
// bad link never turns the projector black.

import { createRenderer, crossfadeWeights } from './gl.js';
import { TV_DEFAULTS } from './tv.js';
import { OVERLAY_DEFAULTS, createOverlay } from './overlay.js';
import { GEN_DEFAULTS, GEN_BY_ID, drawText } from './generators.js';

export const DEFAULT_PARAMS = {
  opacity: 1, speed: 1, loop: true, fit: 'contain', blend: 'normal',
  hue: 0, saturate: 1, contrast: 1, brightness: 1, invert: 0, blur: 0,
  // WebGL only
  zoom: 1, rotate: 0, pixelate: 0, rgbShift: 0, posterize: 0, threshold: 0, mirror: 0, kaleido: 0,
  cropX: 0, cropY: 0,
  palette: 0, edges: 0, halftone: 0, dither: 0, ledWall: 0, ripple: 0, spiral: 0, glitch: 0,
  ascii: 0, riso: 0, warp: 0, radialBlur: 0, stretch: 0, stretchGrid: 0, interference: 0, grain: 0, lumalines: 0, scanMod: 0, fisheye: 0, photocopy: 0,
  ...GEN_DEFAULTS,     // a generator's three sliders and its text: genA, genB, genC, genText
};
export const DEFAULT_MASTER = {
  crossfade: 0, blackout: false, feedback: 0, fbZoom: 1, fbRotate: 0, fbHue: 0, strobe: 0, scale: 0.75,
  fbKey: 0, fbX: 0, fbY: 0, fbTilt: 0, fbBlur: 0,     // feedback: luma key, vanishing point, camera tilt, blur in the loop
  vhs: 0, vhsTrack: 0,                                // worn tape and its mistracking band
  crt: 0, crtCurve: 0,                                // picture tube: scanlines and mask, bulge
  ...TV_DEFAULTS,      // the TV set: tvSignal, tvVHold, tvHHold, tvGhost, tvDelay, tvHum, tvBright
  ...OVERLAY_DEFAULTS, // the image overlay: ovOpacity, ovSize, ovX, ovY, ovBlend, ovBounce
};

// Hosts known to send CORS headers on their video files. archive.org is NOT
// one: its redirect carries Access-Control-Allow-Origin but the storage node
// that serves the bytes does not, so a crossorigin request fails outright.
const CORS_HOSTS = [];

export function canUseGl(source) {
  if (source.kind === 'file' || source.kind === 'gen') return true;
  try {
    const u = new URL(source.url, location.href);
    if (u.origin === location.origin) return true;
    return CORS_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

const cssBlend = (b) => (b === 'add' ? 'plus-lighter' : b);
const LOAD_TIMEOUT = { file: 15000, url: 45000 };

export class Stage {
  // opts: { videos: {A, B}, canvas, layout: (stage) => ({ canvas: [w, h], fbo: [w, h], panes: {out, A?, B?} }), onEvent?,
  //         overlay?: { host, zIndex?, before? } – where the image overlay goes: host's box is the output picture }
  constructor(opts) {
    this.overlay = opts.overlay ? createOverlay(opts.overlay.host, opts.overlay.zIndex, opts.overlay.before) : null;
    this.videos = opts.videos;                      // the active element per deck
    this.standby = {};                              // the element the next clip loads into
    this.canvas = opts.canvas;
    this.layoutFn = opts.layout;
    this.onEvent = opts.onEvent || null;
    this.renderer = opts.canvas ? createRenderer(opts.canvas) : null;
    this.decks = {
      A: { params: { ...DEFAULT_PARAMS }, meta: null, error: null, in: 0, out: null, skips: [], mode: 'css', pending: null, loadSeq: 0 },
      B: { params: { ...DEFAULT_PARAMS }, meta: null, error: null, in: 0, out: null, skips: [], mode: 'css', pending: null, loadSeq: 0 },
    };
    this.master = { ...DEFAULT_MASTER };
    this.enabled = true;          // false = previews off: videos paused, nothing drawn
    this.fps = 0;
    this._frames = 0; this._fpsAt = performance.now();
    this._layout = null;
    for (const name of ['A', 'B']) {
      const v = this.videos[name];
      this._prepElement(v);
      this.standby[name] = this._makeStandby(v);
      this._watchActive(name, v);
    }
    this._loopTimer = setInterval(() => this._checkOut(), 40);
    this.relayout();
    this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  get info() { return this.renderer ? this.renderer.info : null; }
  get elements() { return [...Object.values(this.videos), ...Object.values(this.standby)]; }

  _prepElement(v) { v.muted = true; v.playsInline = true; v.preload = 'auto'; }
  _makeStandby(v) {
    const s = v.cloneNode(false);
    s.removeAttribute('id'); s.removeAttribute('src');
    s.dataset.standby = '1';
    s.style.cssText = v.style.cssText;
    s.style.zIndex = getComputedStyle(v).zIndex;
    s.style.opacity = 0;
    this._prepElement(s);
    v.insertAdjacentElement('afterend', s);
    return s;
  }
  // errors on the element that is on screen (a stream dying mid-play)
  _watchActive(name, v) {
    v.onerror = () => {
      if (this.videos[name] !== v) return;
      const e = v.error;
      this.decks[name].error = e ? `media error ${e.code}${e.message ? ': ' + e.message : ''}` : 'media error';
      if (this.onEvent) this.onEvent({ deck: name, type: 'error', why: this.decks[name].error });
    };
  }
  _release(v) {
    v.pause();
    if (v._objectUrl) { URL.revokeObjectURL(v._objectUrl); v._objectUrl = null; }
    v.removeAttribute('src'); v.load();
    v.style.opacity = 0; v.style.visibility = '';
  }

  relayout() {
    if (!this.renderer) return;
    const l = this.layoutFn(this);
    this._layout = l;
    this.renderer.setCanvasSize(l.canvas[0], l.canvas[1]);
    this.renderer.resize(l.fbo[0], l.fbo[1]);
  }

  // Load into the standby element; swap in when it can play. meta: { title, in, out, skips, time, paused, ... }
  load(name, source, meta) {
    const d = this.decks[name];
    const nv = this.standby[name];
    if (d.pending) { d.pending.cancel(); d.pending = null; }
    const token = ++d.loadSeq;
    if (source.kind === 'gen') { this._loadGen(name, source, meta || null); return; }
    this._release(nv);
    const wantGl = !!this.renderer && canUseGl(source);
    if (wantGl && source.kind === 'url') nv.crossOrigin = 'anonymous'; else nv.removeAttribute('crossorigin');
    if (source.kind === 'file') { nv._objectUrl = URL.createObjectURL(source.file); nv.src = nv._objectUrl; }
    else nv.src = source.url;
    nv.load();
    // seek to the start position once the metadata is in: set earlier, the load algorithm
    // that is still running from load() can reset it to 0
    const startAt = (meta && meta.time) || (meta && meta.in) || 0;
    if (startAt) {
      const seekStart = () => { nv.currentTime = startAt; };
      if (nv.readyState >= 1) seekStart(); else nv.addEventListener('loadedmetadata', seekStart, { once: true });
    }
    const finish = () => { clearTimeout(timer); nv.removeEventListener('canplay', onReady); nv.removeEventListener('error', onError); };
    const fail = (why) => {
      if (!d.pending || d.pending.token !== token) return;
      finish(); d.pending = null; d.error = why; this._release(nv);
      if (this.onEvent) this.onEvent({ deck: name, type: 'loadfail', why, meta });
    };
    const onReady = () => { if (d.pending && d.pending.token === token) { finish(); this._commit(name); } };
    const onError = () => { const e = nv.error; fail(e ? `media error ${e.code}${e.message ? ': ' + e.message : ''}` : 'could not load'); };
    const timer = setTimeout(() => fail('no data from the source (timed out)'), LOAD_TIMEOUT[source.kind] || LOAD_TIMEOUT.url);
    nv.addEventListener('canplay', onReady);
    nv.addEventListener('error', onError);
    d.pending = { token, source, meta: meta || null, wantGl, el: nv, cancel: () => { finish(); this._release(nv); } };
    if (nv.readyState >= 3) onReady();
  }

  // A generator needs no loading: it takes the deck at once, and the clip that was there is let go.
  _loadGen(name, source, meta) {
    const d = this.decks[name];
    if (!this.renderer || !GEN_BY_ID[source.gen]) {
      d.error = this.renderer ? `unknown generator "${source.gen}"` : 'generators need WebGL';
      if (this.onEvent) this.onEvent({ deck: name, type: 'loadfail', why: d.error, meta });
      return;
    }
    this._release(this.videos[name]);
    d.meta = meta; d.error = null; d.source = source; d.in = 0; d.out = null; d.skips = []; d.mode = 'gl';
    d.gen = { id: source.gen, t: (meta && meta.time) || 0, at: Date.now(), paused: !this.enabled || !!(meta && meta.paused) };
    this.applyCss(name);
    if (this.onEvent) this.onEvent({ deck: name, type: 'loaded', meta });
  }
  // A generator's clock runs on the wall clock, not on drawn frames: `t` is its time at the moment
  // `at`, and it has moved on at the deck's speed since. A player in a hidden tab draws nothing,
  // but its generator still is where it should be, and the preview following it never jumps back.
  _genTime(name) {
    const d = this.decks[name], g = d.gen;
    return g.paused ? g.t : g.t + (Date.now() - g.at) / 1000 * (d.params.speed || 1);
  }
  _genSet(name, t, paused) {
    const g = this.decks[name].gen;
    g.t = Math.max(0, t); g.at = Date.now();
    if (paused !== undefined) g.paused = paused;
  }
  // What the renderer needs to draw this frame of a deck's generator.
  _genFrame(name) {
    const d = this.decks[name], g = GEN_BY_ID[d.gen.id], p = d.params;
    let image = null;
    if (g.uses === 'overlay' && this.overlay && this.overlay.size) {
      image = { el: this.overlay.el, w: this.overlay.size[0], h: this.overlay.size[1], stamp: 'ov:' + this.overlay.el.src };
    } else if (g.uses === 'text') {
      const text = String(p.genText ?? '');
      if (d.gen.text !== text) { d.gen.text = text; d.gen.canvas = drawText(d.gen.cv || (d.gen.cv = document.createElement('canvas')), text); }
      if (d.gen.canvas) image = { el: d.gen.canvas, w: d.gen.canvas.width, h: d.gen.canvas.height, stamp: 'text:' + text };
    }
    return { id: d.gen.id, time: this._genTime(name), a: p.genA, b: p.genB, c: p.genC, image };
  }
  // A still of a generator for its library card, as a data URL ('' without WebGL).
  genThumb(id, w = 160, h = 90) {
    const g = GEN_BY_ID[id];
    if (!this.renderer || !g) return '';
    let image = null;
    if (g.uses === 'text') { const cv = drawText(document.createElement('canvas'), GEN_DEFAULTS.genText); image = { el: cv, w: cv.width, h: cv.height, stamp: 'thumb-text' }; }
    const px = this.renderer.genThumb({ id, time: 4.2, a: 0.5, b: 0.5, c: 0.5, image }, w, h);
    if (!px) return '';
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
    return cv.toDataURL('image/jpeg', 0.75);
  }
  // Keep a generator in step with another stage's (the controller's preview follows the player).
  syncGen(name, time, paused) {
    const g = this.decks[name].gen;
    if (!g) return;
    const now = this._genTime(name), stop = !!paused || !this.enabled;
    if (Math.abs(now - time) > 0.3) this._genSet(name, time, stop);
    else if (stop !== g.paused) this._genSet(name, now, stop);
  }

  _commit(name) {
    const d = this.decks[name], p = d.pending;
    d.pending = null;
    const old = this.videos[name], nv = p.el;
    this.videos[name] = nv; this.standby[name] = old;
    // the id (and with it the page's CSS rules and anyone's querySelector) follows the active element
    const id = old.id; old.removeAttribute('id'); if (id) nv.id = id;
    nv.dataset.standby = ''; old.dataset.standby = '1';
    d.meta = p.meta; d.error = null; d.source = p.source;
    d.in = (p.meta && p.meta.in) || 0; d.out = (p.meta && p.meta.out) || null;
    d.skips = (p.meta && p.meta.skips) || [];
    d.mode = p.wantGl ? 'gl' : 'css'; d.gen = null;
    this._release(old);
    this._watchActive(name, nv);
    this.applyCss(name);
    if (this.enabled && !(p.meta && p.meta.paused)) this.play(name); else nv.pause();
    if (this.onEvent) this.onEvent({ deck: name, type: 'loaded', meta: p.meta });
  }

  play(name) {
    const g = this.decks[name].gen;
    if (g) { if (g.paused) this._genSet(name, g.t, false); return; }
    const p = this.videos[name].play(); if (p) p.catch(() => {});
  }
  pause(name) { if (this.decks[name].gen) this._genSet(name, this._genTime(name), true); else this.videos[name].pause(); }
  restart(name) { if (this.decks[name].gen) this._genSet(name, 0, false); else { this.videos[name].currentTime = this.decks[name].in; this.play(name); } }
  seek(name, t) { if (this.decks[name].gen) this._genSet(name, t); else this.videos[name].currentTime = t; }
  setParams(name, params) {
    if ('speed' in params && this.decks[name].gen) this._genSet(name, this._genTime(name));   // the time so far was at the old speed
    Object.assign(this.decks[name].params, params); this.applyCss('A'); this.applyCss('B');
  }
  setMaster(params) {
    const scaleChanged = 'scale' in params && params.scale !== this.master.scale;
    Object.assign(this.master, params);
    this.applyCss('A'); this.applyCss('B');
    if (scaleChanged) this.relayout();
  }
  setEnabled(on) {
    this.enabled = on;
    for (const name of ['A', 'B']) { if (on) { if (this.decks[name].meta) this.play(name); } else this.pause(name); }
    if (!on && this.renderer) this.renderer.clear();
    if (!on && this.overlay) this.overlay.update(this.master, false);
  }
  // source: { file, name } | { url, name } | null
  setOverlay(source) { if (this.overlay) this.overlay.set(source); }

  // CSS side: opacity/filters on the video layers, and the canvas blend mode
  // when deck B is on the canvas above a CSS deck A.
  applyCss(name) {
    const v = this.videos[name], d = this.decks[name], p = d.params;
    const [mA, mB] = crossfadeWeights(this.master.crossfade, this.decks.B.params.blend);
    const mix = name === 'A' ? mA : mB;
    if (d.mode === 'gl' || !d.meta) {
      v.style.opacity = 0;
      v.style.filter = 'none';
      v.style.transform = 'none';
      v.style.clipPath = '';
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
      // CSS cannot re-fit a cropped picture; trim the bars and scale up so cover still fills
      const cx = Math.min(0.45, p.cropX || 0), cy = Math.min(0.45, p.cropY || 0);
      const k = p.fit === 'cover' ? 1 / (1 - 2 * Math.max(cx, cy)) : 1;
      v.style.clipPath = cx || cy ? `inset(${cy * 100}% ${cx * 100}%)` : '';
      v.style.transform = `scale(${(p.zoom || 1) * k}) rotate(${p.rotate || 0}deg)`;
    }
    this.standby[name].style.opacity = 0;
    v.playbackRate = p.speed;
    v.loop = p.loop && !d.out;
    v.classList.toggle('cover', p.fit === 'cover');
    if (name === 'B') v.style.mixBlendMode = cssBlend(p.blend);
    if (this.canvas) {
      const A = this.decks.A, B = this.decks.B;
      this.canvas.style.mixBlendMode = (A.mode === 'css' && A.meta && B.mode === 'gl') ? cssBlend(B.params.blend) : 'normal';
    }
  }

  _checkOut() {
    for (const name of ['A', 'B']) {
      const d = this.decks[name], v = this.videos[name];
      if (d.out && v.currentTime >= d.out) {
        if (d.params.loop) v.currentTime = d.in; else v.pause();
        continue;
      }
      if (d.skips && d.skips.length && !v.seeking) {
        const t = v.currentTime;
        const s = d.skips.find(([a, b]) => t >= a && t < b - 0.05);
        if (s) {
          const end = d.out || (isFinite(v.duration) ? v.duration : Infinity);
          if (s[1] >= end - 0.1) { if (d.params.loop) v.currentTime = d.in; else v.pause(); }
          else v.currentTime = s[1];
        }
      }
    }
  }

  _frame(now) {
    this._raf = requestAnimationFrame((t) => this._frame(t));
    if (!this.enabled) return;
    // strobe for CSS-mode decks: blink the video layer itself
    const strobe = this.master.strobe || 0;
    const lit = strobe > 0 ? ((now / 1000 * strobe) % 1 < 0.5) : true;
    for (const name of ['A', 'B']) {
      const v = this.videos[name];
      if (this.decks[name].mode === 'css') v.style.visibility = lit ? '' : 'hidden';
      else if (v.style.visibility) v.style.visibility = '';
    }
    if (this.overlay) this.overlay.update(this.master, lit);
    if (!this.renderer) return;
    const decks = {};
    let anyGl = false;
    // A deck the crossfader (or its opacity) has faded out entirely, and that no pane shows on its
    // own, is not drawn at all: no video upload, no generator, no effect pass. On the player that
    // is half the work whenever the fader rests at one end.
    const mixW = crossfadeWeights(this.master.crossfade, this.decks.B.params.blend);
    for (const name of ['A', 'B']) {
      const d = this.decks[name], v = this.videos[name];
      let active = false, gen = null;
      const seen = !!this._layout.panes[name] || mixW[name === 'A' ? 0 : 1] * (d.params.opacity ?? 1) > 0;
      if (!seen) { /* skipped */ }
      else if (d.gen) {                                      // a generator: its own clock, at the deck's speed
        gen = this._genFrame(name); active = true;
      } else if (d.mode === 'gl' && v.readyState >= 2) {
        if (this.renderer.upload(name, v)) active = true;
        else { d.mode = 'css'; this.applyCss(name); }      // tainted after all: fall back
      }
      anyGl = anyGl || d.mode === 'gl';
      decks[name] = { params: d.params, active, gen };
    }
    if (anyGl) this.renderer.render(decks, this.master, now / 1000, this._layout.panes);
    else this.renderer.clear();
    this._frames++;
    if (now - this._fpsAt > 1000) { this.fps = Math.round(this._frames * 1000 / (now - this._fpsAt)); this._frames = 0; this._fpsAt = now; }
  }

  status() {
    const decks = {};
    for (const name of ['A', 'B']) {
      const d = this.decks[name], v = this.videos[name];
      decks[name] = {
        time: d.gen ? this._genTime(name) : v.currentTime, duration: d.gen || !isFinite(v.duration) ? null : v.duration,
        paused: d.gen ? d.gen.paused : v.paused, ready: d.gen ? true : v.readyState >= 2, error: d.error, mode: d.mode,
        loading: d.pending ? (d.pending.meta && d.pending.meta.key) || true : null,
        meta: d.meta, params: d.params,
      };
    }
    return { decks, master: this.master, fps: this.fps, gpu: this.info, overlay: this.overlay ? this.overlay.name : null };
  }
}
