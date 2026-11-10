// A stage is two <video> elements and a canvas that composites them. The
// player owns one filling the window; the controller owns one for its live
// previews. Both run the same code, so what the controller shows is what the
// projector gets.
//
// A deck whose video WebGL may read (local file, same-origin URL) is drawn on
// the canvas with the full effect chain. A deck fed by a stream from a host
// without CORS headers is left as a visible <video> layer with CSS filters:
// video A sits under the canvas, video B above it.

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

export class Stage {
  // opts: { videos: {A, B}, canvas, layout: () => ({ canvas: [w, h], fbo: [w, h], panes: {out, A?, B?} }) }
  constructor(opts) {
    this.videos = opts.videos;
    this.canvas = opts.canvas;
    this.layoutFn = opts.layout;
    this.renderer = opts.canvas ? createRenderer(opts.canvas) : null;
    this.decks = {
      A: { params: { ...DEFAULT_PARAMS }, meta: null, objectUrl: null, error: null, in: 0, out: null, mode: 'css' },
      B: { params: { ...DEFAULT_PARAMS }, meta: null, objectUrl: null, error: null, in: 0, out: null, mode: 'css' },
    };
    this.master = { ...DEFAULT_MASTER };
    this.enabled = true;          // false = previews off: videos paused, nothing drawn
    this.fps = 0;
    this._frames = 0; this._fpsAt = performance.now();
    this._layout = null;
    for (const name of ['A', 'B']) {
      const v = this.videos[name];
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.addEventListener('error', () => {
        const e = v.error;
        this.decks[name].error = e ? `media error ${e.code}${e.message ? ': ' + e.message : ''}` : 'media error';
      });
    }
    this._loopTimer = setInterval(() => this._checkOut(), 40);
    this.relayout();
    this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  get info() { return this.renderer ? this.renderer.info : null; }

  relayout() {
    if (!this.renderer) return;
    const l = this.layoutFn(this);
    this._layout = l;
    this.renderer.setCanvasSize(l.canvas[0], l.canvas[1]);
    this.renderer.resize(l.fbo[0], l.fbo[1]);
  }

  load(name, source, meta) {
    const d = this.decks[name], v = this.videos[name];
    if (d.objectUrl) { URL.revokeObjectURL(d.objectUrl); d.objectUrl = null; }
    d.error = null; d.meta = meta || null;
    d.in = (meta && meta.in) || 0; d.out = (meta && meta.out) || null;
    d.mode = this.renderer && canUseGl(source) ? 'gl' : 'css';
    v.pause();
    v.removeAttribute('src');
    if (d.mode === 'gl' && source.kind === 'url') v.crossOrigin = 'anonymous'; else v.removeAttribute('crossorigin');
    if (source.kind === 'file') { d.objectUrl = URL.createObjectURL(source.file); v.src = d.objectUrl; }
    else v.src = source.url;
    v.load();
    v.currentTime = (meta && meta.time) || d.in;
    if (this.enabled && !(meta && meta.paused)) this.play(name);
    this.applyCss(name);
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
        meta: d.meta, params: d.params,
      };
    }
    return { decks, master: this.master, fps: this.fps, gpu: this.info };
  }
}
