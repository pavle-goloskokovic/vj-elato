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

export const DEFAULT_PARAMS = {
  opacity: 1, speed: 1, loop: true, fit: 'contain', blend: 'normal',
  hue: 0, saturate: 1, contrast: 1, brightness: 1, invert: 0, blur: 0,
  // WebGL only
  zoom: 1, rotate: 0, pixelate: 0, rgbShift: 0, posterize: 0, threshold: 0, mirror: 0, kaleido: 0,
  cropX: 0, cropY: 0,
};
export const DEFAULT_MASTER = {
  crossfade: 0, blackout: false, feedback: 0, fbZoom: 1, fbRotate: 0, fbHue: 0, strobe: 0, scale: 0.75,
};

// Hosts known to send CORS headers on their video files. archive.org is NOT
// one: its redirect carries Access-Control-Allow-Origin but the storage node
// that serves the bytes does not, so a crossorigin request fails outright.
const CORS_HOSTS = [];

export function canUseGl(source) {
  if (source.kind === 'file') return true;
  try {
    const u = new URL(source.url, location.href);
    if (u.origin === location.origin) return true;
    return CORS_HOSTS.some((re) => re.test(u.hostname));
  } catch { return false; }
}

const cssBlend = (b) => (b === 'add' ? 'plus-lighter' : b);
const LOAD_TIMEOUT = { file: 15000, url: 45000 };

export class Stage {
  // opts: { videos: {A, B}, canvas, layout: (stage) => ({ canvas: [w, h], fbo: [w, h], panes: {out, A?, B?} }), onEvent? }
  constructor(opts) {
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
    this._release(nv);
    const wantGl = !!this.renderer && canUseGl(source);
    if (wantGl && source.kind === 'url') nv.crossOrigin = 'anonymous'; else nv.removeAttribute('crossorigin');
    if (source.kind === 'file') { nv._objectUrl = URL.createObjectURL(source.file); nv.src = nv._objectUrl; }
    else nv.src = source.url;
    nv.load();
    const startAt = (meta && meta.time) || (meta && meta.in) || 0;
    if (startAt) nv.currentTime = startAt;
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
    d.mode = p.wantGl ? 'gl' : 'css';
    this._release(old);
    this._watchActive(name, nv);
    this.applyCss(name);
    if (this.enabled && !(p.meta && p.meta.paused)) this.play(name); else nv.pause();
    if (this.onEvent) this.onEvent({ deck: name, type: 'loaded', meta: p.meta });
  }

  play(name) { const p = this.videos[name].play(); if (p) p.catch(() => {}); }
  pause(name) { this.videos[name].pause(); }
  restart(name) { this.videos[name].currentTime = this.decks[name].in; this.play(name); }
  seek(name, t) { this.videos[name].currentTime = t; }
  setParams(name, params) { Object.assign(this.decks[name].params, params); this.applyCss('A'); this.applyCss('B'); }
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
  }

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
    if (!this.renderer) return;
    const decks = {};
    let anyGl = false;
    for (const name of ['A', 'B']) {
      const d = this.decks[name], v = this.videos[name];
      let active = false;
      if (d.mode === 'gl' && v.readyState >= 2) {
        if (this.renderer.upload(name, v)) active = true;
        else { d.mode = 'css'; this.applyCss(name); }      // tainted after all: fall back
      }
      anyGl = anyGl || d.mode === 'gl';
      decks[name] = { params: d.params, active };
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
        time: v.currentTime, duration: isFinite(v.duration) ? v.duration : null,
        paused: v.paused, ready: v.readyState >= 2, error: d.error, mode: d.mode,
        loading: d.pending ? (d.pending.meta && d.pending.meta.key) || true : null,
        meta: d.meta, params: d.params,
      };
    }
    return { decks, master: this.master, fps: this.fps, gpu: this.info };
  }
}
