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
  { name: 'wave', seconds: 12, fn: (u, v, t) => {
      // diagonal lines sliding left to right: five pixels wide, ten apart
      const phase = ((u * 16 + v * 12 * 0.45 - t * 6) % 10 + 10) % 10;      // in pixels along the slide
      return phase < 5 ? 1 : 0;
    } },
  { name: 'ripples', seconds: 14, fn: (u, v, t, c) => {
      // A ring growing out of one jog wheel, then the other. The disc is the block of pixels under
      // the jog (columns 10-15 rows 5-8 plus columns 11-14 rows 4 and 9; mirrored for the left
      // deck). A pixel is lit when its distance to the nearest disc pixel, with horizontal
      // distances scaled by 1.2, is in [r, r + 2): a ring two pixels thick. r runs from 0 (a
      // one-pixel ring hugging the disc) outward across the panel; radii at which no light would
      // be lit are skipped, so there are no empty frames.
      const dist = (x, y, left) => {
        let best = 99;
        for (let hy = 4; hy <= 9; hy++) for (let hx = 10; hx <= 15; hx++) {
          if ((hy === 4 || hy === 9) && (hx === 10 || hx === 15)) continue;
          const dx = (x - (left ? 15 - hx : hx)) * 1.2, dy = y - hy; const d = Math.sqrt(dx * dx + dy * dy); if (d < best) best = d;
        }
        return best;
      };
      const ring = (d, r) => d > 0 && d >= r && d < r + 2;
      if (!c.rippleTable) {
        const N = 150, RMAX = 15, table = {};
        for (const left of [true, false]) {
          const ld = c.lights.map((l) => dist(Math.floor(l.u * 16), Math.floor(l.v * 12), left));
          const w = []; let total = 0;
          for (let k = 0; k < N; k++) { const r = k * RMAX / N; total += ld.some((d) => ring(d, r)) ? 1 : 0; w.push(total); }
          table[left ? 'L' : 'R'] = { w, total, N, RMAX };
        }
        c.rippleTable = table;
      }
      const period = 2.4, GAP = 0.2, k = Math.floor(t / period), left = k % 2 === 0, tt = t % period;
      if (tt >= period - GAP) return 0;                       // a dark pause of 0.2 s (three frames) between rings
      if (c.rippleT !== t) {
        const { w, total, N, RMAX } = c.rippleTable[left ? 'L' : 'R'], ph = (tt / (period - GAP)) * total;
        let n = 0; while (n < N - 1 && w[n] <= ph) n++;
        c.rippleR = n * RMAX / N; c.rippleT = t;
      }
      return ring(dist(Math.floor(u * 16), Math.floor(v * 12), left), c.rippleR) ? 1 : 0;
    } },
  { name: 'radar', seconds: 12, fn: (u, v, t) => {
      // a cone sweeping around each jog wheel, left one clockwise, right one counter-clockwise,
      // each staying on its own half of the panel. Cone: 80 degrees wide, one turn every 2.7 s.
      const x = u * 16, y = v * 12, left = x < 8;
      const cx = left ? 3 : 13, cy = 7, dir = left ? 1 : -1;
      const a = Math.atan2(y - cy, x - cx), d = ((a - dir * t * 2.3) % TAU + TAU) % TAU;
      return Math.min(d, TAU - d) < 0.7 ? 1 : 0;
    } },
  { name: 'rain', seconds: 12, fn: (u, v, t) => {
      const col = Math.floor(u * 14), speed = 0.35 + hash(col, 1) * 0.5, off = hash(col, 2) * 3;
      const p = ((t * speed + off) % 1.5) - 0.25;            // head position falls through the panel
      const d = p - v;
      return d > 0 && d < 0.22 ? smooth(1 - d / 0.22) : 0;
    } },
  { name: 'bounce', seconds: 12, fn: (u, v, t) => {
      // a ball 5 pixels across bouncing around the panel at constant speed, its centre reaching
      // half a pixel from the edges so it rolls over the outer rows. The path (9 horizontal and
      // 6 vertical half-bounces per 32 s loop, with these phases) was picked by searching all such
      // paths for one that visits every light, spends the most time over the red and green
      // transport buttons, and has the fewest dark frames.
      const R = 2.5, M = 0.5, LOOP = 32, tri = (x) => { const m = x % 2; return m < 1 ? m : 2 - m; };
      const s = t % LOOP;
      const bx = M + (16 - 2 * M) * tri(s * 18 / LOOP), by = M + (12 - 2 * M) * tri(s * 12 / LOOP + 0.25);
      return Math.hypot(u * 16 - bx, v * 12 - by) < R ? 1 : 0;
    } },
  { name: 'breathe', seconds: 10, fn: (u, v, t) => {
      const p = 0.5 + 0.5 * Math.sin(t * 1.8);                // the whole panel breathes, each light slightly out of phase
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
  { name: 'xmas', seconds: 12, fn: (u, v, t) => {
      // christmas lights: the pixels are strung in three groups along the diagonals, and the groups
      // light in turn, with a twinkle now and then
      const x = Math.floor(u * 16), y = Math.floor(v * 12), step = Math.floor(t * 2.5);
      const group = (x + 2 * y) % 3;
      if (group === step % 3) return 1;
      return hash(x * 7 + y, step) < 0.06 ? 1 : 0;
    } },
  { name: 'stick', seconds: 14, fn: (u, v, t) => {
      // a stick through the centre of one jog turns half a circle, stalls, then a stick on the other
      // jog turns half a circle the other way, stalls, and so on
      const turn = 1.3, stall = 0.4, period = 2 * (turn + stall), tt = t % period;
      const left = tt < turn + stall, p = Math.min(1, (left ? tt : tt - turn - stall) / turn);
      const ang = left ? p * Math.PI : -p * Math.PI;                         // starts and stalls horizontal
      const x = u * 16, y = v * 12;
      const cx = left ? 3 : 13, cy = 5.5, dx = x - cx, dy = y - cy;      // pivot on the cue row: the horizontal stick is rows 4-6, centred on the cue and browse lights
      const along = dx * Math.cos(ang) + dy * Math.sin(ang), across = -dx * Math.sin(ang) + dy * Math.cos(ang);
      return Math.abs(across) < 1.5 ? 1 : 0;                                 // three pixels wide, spans the whole display
    } },
  { name: 'propeller', seconds: 12, fn: (u, v, t, c) => {
      // a propeller turning around the centre of the panel: blades narrow at the hub (under one
      // pixel, so the four centre lights only blink as a blade passes) and three pixels wide at
      // the tips. Angles at which no light would be lit (near vertical) are hurried through, so
      // there are no empty frames; the rest turns at one revolution every 3 s.
      const blade = (ang, x, y) => {
        const dx = x - 8, dy = y - 5.5;
        const along = dx * Math.cos(ang) + dy * Math.sin(ang), across = -dx * Math.sin(ang) + dy * Math.cos(ang);
        return Math.abs(across) < 0.25 + 1.35 * Math.min(1, Math.abs(along) / 8);
      };
      if (!c.propTable) {
        const w = [], N = 360; let total = 0;
        for (let k = 0; k < N; k++) {
          const ang = k * Math.PI / N;                       // the blade has two-fold symmetry: half a turn is enough
          const lit = c.lights.some((l) => blade(ang, l.u * 16, l.v * 12));
          total += lit ? 1 : 0.08; w.push(total);
        }
        c.propTable = { w, total, N };
      }
      if (c.propT !== t) {
        const { w, total, N } = c.propTable, ph = ((t * 2.1 / Math.PI) % 1 + 1) % 1 * total;
        let k = 0; while (k < N - 1 && w[k] < ph) k++;
        c.propAng = k * Math.PI / N; c.propT = t;
      }
      return blade(c.propAng, u * 16, v * 12) ? 1 : 0;
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
    const cols = layout.cols || 48, rows = layout.rows || Math.round(cols / aspect);
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
