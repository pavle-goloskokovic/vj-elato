// Idle light show for a MIDI controller's LEDs.
//
// The controller's lights are treated as a sparse monochrome display: the device file gives
// every LED a position on the top panel (fractions of width and height). Animations are
// written for the whole panel as a function (u, v, t) -> brightness; each LED samples the
// function at its own position and lights when the value passes 0.5. A preview canvas
// renders the same function over a fine grid, with the LEDs drawn on top, so the show can
// be designed and watched without the hardware.

const TAU = Math.PI * 2;
const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
const smooth = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Each animation: { name, seconds, fn(u, v, t, ctx) -> 0..1 }. ctx has aspect (width/height),
// so distances and angles come out right on the panel, and the light list for chases.
export const ANIMATIONS = [
  { name: 'wave', seconds: 12, fn: (u, v, t) => clamp01(0.5 + 0.6 * Math.sin(u * TAU * 1.2 - t * 2.2 + Math.sin(t * 0.7) * v * 2)) },
  { name: 'ripples', seconds: 14, fn: (u, v, t, c) => {
      // rings expanding from one jog wheel, then the other, then the middle
      const phase = Math.floor(t / 4.5) % 3, cx = [0.21, 0.79, 0.5][phase], cy = 0.55;
      const d = Math.hypot((u - cx) * c.aspect, v - cy);
      return clamp01(0.5 + 0.7 * Math.cos(d * 22 - t * 5)) * (d < 1.1 ? 1 : 0);
    } },
  { name: 'radar', seconds: 12, fn: (u, v, t, c) => {
      // a sweep around each jog wheel, counter-rotating, with a fading trail
      const arm = (cx, dir) => { const a = Math.atan2(v - 0.55, (u - cx) * c.aspect); let d = ((a - dir * t * 1.6) % TAU + TAU) % TAU; return Math.exp(-d * 1.8); };
      return clamp01(Math.max(arm(0.21, 1), arm(0.79, -1)));
    } },
  { name: 'rain', seconds: 12, fn: (u, v, t) => {
      const col = Math.floor(u * 14), speed = 0.35 + hash(col, 1) * 0.5, off = hash(col, 2) * 3;
      const p = ((t * speed + off) % 1.5) - 0.25;            // head position falls through the panel
      const d = p - v;
      return d > 0 && d < 0.22 ? smooth(1 - d / 0.22) : 0;
    } },
  { name: 'bounce', seconds: 12, fn: (u, v, t, c) => {
      const tri = (x, p) => { const m = (x % (2 * p)); return m < p ? m / p : 2 - m / p; };
      const bx = 0.06 + 0.88 * tri(t * 0.37, 1), by = 0.08 + 0.84 * tri(t * 0.53 + 0.3, 1);
      const d = Math.hypot((u - bx) * c.aspect, v - by);
      return clamp01(1.1 - d / 0.16);
    } },
  { name: 'breathe', seconds: 10, fn: (u, v, t) => {
      const p = 0.5 + 0.5 * Math.sin(t * 1.3);                // the whole panel breathes, each light slightly out of phase
      const j = hash(Math.floor(u * 40), Math.floor(v * 30)) * 0.35;
      return clamp01(p - j + 0.2);
    } },
  { name: 'chase', seconds: 12, fn: (u, v, t, c) => {
      // three points running along the lights ordered by angle around the panel centre
      if (!c.lights.length) return 0;
      const n = c.lights.length, head = (t * 9) % n;
      const me = c.lightIndex(u, v); if (me < 0) return 0;
      let best = 0;
      for (let k = 0; k < 3; k++) { const h = (head + k * n / 3) % n; let d = (me - h + n) % n; best = Math.max(best, Math.exp(-d * 0.9)); }
      return best;
    } },
  { name: 'life', seconds: 16, fn: (u, v, t, c) => c.life(u, v, t) },
  { name: 'sparkle', seconds: 10, fn: (u, v, t) => {
      const cell = hash(Math.floor(u * 50), Math.floor(v * 40));
      const ph = (t * (0.6 + cell * 1.2) + cell * 7) % 1;
      return ph < 0.18 ? 1 : 0;
    } },
  { name: 'curtain', seconds: 10, fn: (u, v, t) => {
      // halves close and open, then quarters
      const m = Math.floor(t / 5) % 2 ? Math.abs(u - 0.5) * 2 : Math.max(Math.abs(u - 0.5) * 2, Math.abs(v - 0.5) * 2);
      const edge = 0.5 + 0.5 * Math.sin(t * 1.4);
      return m < edge ? 1 : 0;
    } },
];

export function createLightShow(layout, opts = {}) {
  const lights = Object.entries(layout.lights).map(([id, [u, v]]) => ({ id, u, v }));
  const aspect = layout.aspect || 1.5;
  const centre = { u: 0.5, v: 0.5 };
  lights.sort((a, b) => Math.atan2(a.v - centre.v, (a.u - centre.u) * aspect) - Math.atan2(b.v - centre.v, (b.u - centre.u) * aspect));
  const indexByKey = new Map(lights.map((l, i) => [`${l.u},${l.v}`, i]));

  // Game of Life on a coarse grid, stepping with time; reseeded when the animation starts
  const LW = 24, LH = 16; let cells = null, lastStep = -1;
  function lifeStep() {
    const next = new Uint8Array(LW * LH);
    for (let y = 0; y < LH; y++) for (let x = 0; x < LW; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) n += cells[((y + dy + LH) % LH) * LW + (x + dx + LW) % LW];
      const alive = cells[y * LW + x];
      next[y * LW + x] = (alive && (n === 2 || n === 3)) || (!alive && n === 3) ? 1 : 0;
    }
    cells = next;
  }
  function life(u, v, t) {
    const step = Math.floor(t / 0.35);
    if (!cells || step < lastStep) { cells = new Uint8Array(LW * LH); for (let i = 0; i < cells.length; i++) cells[i] = hash(i, t) < 0.42 ? 1 : 0; lastStep = step; }
    while (lastStep < step) { lifeStep(); lastStep++; }
    return cells[Math.min(LH - 1, Math.floor(v * LH)) * LW + Math.min(LW - 1, Math.floor(u * LW))];
  }
  const ctx = { aspect, lights, lightIndex: (u, v) => indexByKey.get(`${u},${v}`) ?? -1, life };

  let order = shuffle(ANIMATIONS.map((_, i) => i)), pos = 0, startedAt = 0, t0 = 0;
  function current(now) {
    if (!startedAt) { startedAt = now; t0 = now; }
    let anim = ANIMATIONS[order[pos]];
    if (now - t0 > anim.seconds * 1000) { pos = (pos + 1) % order.length; if (pos === 0) order = shuffle(order); t0 = now; cells = null; anim = ANIMATIONS[order[pos]]; }
    return { anim, t: (now - t0) / 1000, age: (now - t0) / 1000 };
  }
  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  // One frame: which lights are on. A one-second fade-in at the start of each animation.
  function frame(now, force) {
    const { anim, t, age } = force ? { anim: force, t: (now - t0) / 1000, age: 1 } : current(now);
    const gain = Math.min(1, age);
    const on = {};
    for (const l of lights) on[l.id] = anim.fn(l.u, l.v, t, ctx) * gain > 0.5;
    return { name: anim.name, on, t, fn: anim.fn };
  }
  function reset() { startedAt = 0; cells = null; }

  // Preview: the virtual display as a fine grid plus the lights as dots
  function draw(canvas, now, result) {
    const g = canvas.getContext('2d'); const W = canvas.width, H = canvas.height;
    const r = result || frame(now);
    g.fillStyle = '#0b0b0e'; g.fillRect(0, 0, W, H);
    const cols = 48, rows = Math.round(48 / aspect);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const b = r.fn((x + 0.5) / cols, (y + 0.5) / rows, r.t, ctx);
      if (b <= 0.05) continue;
      g.fillStyle = `rgba(255,181,71,${(b * 0.28).toFixed(3)})`;
      g.fillRect(x * W / cols, y * H / rows, W / cols - 0.5, H / rows - 0.5);
    }
    for (const l of lights) {
      g.beginPath(); g.arc(l.u * W, l.v * H, Math.max(3, W / 110), 0, TAU);
      g.fillStyle = r.on[l.id] ? '#ffd66b' : '#2a2a30'; g.fill();
      if (r.on[l.id]) { g.strokeStyle = 'rgba(255,214,107,.45)'; g.lineWidth = 3; g.stroke(); }
    }
    return r;
  }

  return { frame, draw, reset, lights, animations: ANIMATIONS, pick: (name) => ANIMATIONS.find((a) => a.name === name) };
}
