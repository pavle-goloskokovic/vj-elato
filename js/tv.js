// The master "TV" effect's receiver: a simulated television set's sync circuits.
//
// Glitches are never drawn. The set's horizontal AFC, vertical oscillator and colour
// reference are simulated scan line by scan line against a signal whose level and
// timing the knobs disturb, and the picture rolls, tears, bends and loses colour the
// way those circuits respond. The shader in gl.js then scans every screen pixel from
// the signal position this simulation says the beam was reading.
//
// Ported from the Glitch stage of NTSCRT (https://github.com/finnmckenty/NTSCRT,
// port/engine/src/glitch/receiver.rs and glitch.wgsl), whose design follows Trevor
// Blackwell's analogtv. Differences from the original:
//  - no VCR: the signal's own timing is perfect, so every line is 63.556 µs long;
//  - the set always runs at 240 picture lines, whatever the render size, and the
//    shader keeps the picture's full resolution inside each line;
//  - the colour reference loop runs here instead of on the GPU, so where the burst
//    gate lands on picture instead of burst it reads a stand-in chroma, not the
//    picture's own;
//  - 32-bit hashes, so the noise is not bit-identical to NTSCRT's.
//
// NTSCRT is MIT licensed:
//
//   Copyright (c) 2026 Finn McKenty
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy
//   of this software and associated documentation files (the "Software"), to deal
//   in the Software without restriction, including without limitation the rights
//   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//   SOFTWARE.

// NTSC line timing (SMPTE 170M), in µs. gl.js repeats the ones its shader needs.
export const TIMING = {
  LINE: 63.556, SYNC: 4.7, BURST_START: 5.3, BURST_END: 7.8,
  GATE_START: 4.55, GATE_END: 8.55,            // the set's 4 µs burst gate
  ACTIVE_START: 9.4, ACTIVE_LENGTH: 52.656,
  EQUALIZING_PULSE: 2.3, BROAD_PULSE: 27.1,
  FIELD_RATE: 60000 / 1001, LINES_PER_FIELD: 262.5, SUBCARRIER_MHZ: 315 / 88,
  BURST_I: 0.5446390350150271, BURST_Q: -0.8386705679454240,   // burst direction in the I/Q plane
  BURST_AMPLITUDE: 20 / 92.5,                                    // 20 IRE on the decoder's luma scale
};
const T = TIMING;
const TAU = 2 * Math.PI;
const WARMUP = 2;                 // the set has been on this long at time zero
const SEED = 0x4E545343;
const ACTIVE_LINES = 240;
const GATE_SAMPLES = 16;

export const TV_DEFAULTS = { tvSignal: 1, tvVHold: 0, tvHHold: 0, tvGhost: 0, tvDelay: 2, tvHum: 0, tvBright: 0 };

// True when any knob is off its healthy position.
export function tvActive(m) {
  return (m.tvSignal ?? 1) < 1 || !!m.tvVHold || !!m.tvHHold || !!m.tvGhost || (m.tvHum || 0) > 0 || (m.tvBright || 0) > 0;
}

// ---- deterministic noise, keyed by position, never by call order ----
function hash(seed, purpose, a, b) {
  let h = Math.imul(seed | 0, 0x8DA6B343) ^ Math.imul(purpose | 0, 0xD8163841) ^ Math.imul(a | 0, 0xCB1AB31F) ^ Math.imul(b | 0, 0x165667B1);
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
  return h >>> 0;
}
function uni(seed, purpose, a, b = 0) { return (hash(seed, purpose, a, b) + 0.5) / 4294967296; }
function gauss(seed, purpose, a, b = 0) {
  return Math.sqrt(-2 * Math.log(uni(seed, purpose, a, b))) * Math.cos(TAU * uni(seed, purpose + 0x51, a, b));
}
// smooth 1-D value noise in [-1, 1]
function value(seed, purpose, x) {
  const i = Math.floor(x), f = x - i;
  const a = uni(seed, purpose, i) * 2 - 1, b = uni(seed, purpose, i + 1) * 2 - 1;
  return a + (b - a) * f * f * (3 - 2 * f);
}
// complementary error function, fractional error below 1.2e-7 (Numerical Recipes erfcc)
function erfc(x) {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
    + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}
const phi = (x) => 0.5 * erfc(-x / Math.SQRT2);           // standard normal CDF
const posmod = (a, m) => ((a % m) + m) % m;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The raster: the picture's rows are the active lines, with a vertical blanking
// interval in NTSC proportion above them.
function makeRaster(activeLines) {
  const vbi = Math.max(12, Math.round(activeLines * 20 / 242.5));
  const total = activeLines + vbi;
  const scale = total / T.LINES_PER_FIELD;                 // raster lines per NTSC line
  const eq = Math.max(1, Math.round(3 * scale));
  return { activeLines, vbiLines: vbi, totalLines: total, scale, preEqEnd: eq, vsyncEnd: 2 * eq, postEqEnd: 3 * eq };
}
function syncDuty(raster, jf) {
  if (jf < raster.preEqEnd || (jf >= raster.vsyncEnd && jf < raster.postEqEnd)) return 2 * T.EQUALIZING_PULSE / T.LINE;
  if (jf < raster.vsyncEnd) return 2 * T.BROAD_PULSE / T.LINE;
  return T.SYNC / T.LINE;
}

// knobs -> circuit constants
function knobs(m, raster) {
  const s = raster.scale;
  const strength = clamp(m.tvSignal ?? 1, 0, 1);
  const vKnob = clamp(m.tvVHold || 0, -1, 1), hKnob = clamp(m.tvHHold || 0, -1, 1);
  const builtIn = 0.002, vLock = 0.015;
  const kpN = 0.04 * Math.pow(10, 0.5);                    // AFC response at its middle setting
  const edge = kpN / TAU;                                  // where horizontal lock breaks
  const hAbs = Math.abs(hKnob);
  const hFree = hAbs <= 0.35 ? edge * (hAbs / 0.35) ** 2 : edge + 0.0265 * (hAbs - 0.35) / 0.65;
  return {
    // carrier-to-noise falls linearly from 38 dB to 0 across the knob
    sigma: Math.max(0, 100 * Math.pow(10, -1.9 * strength) - 1.26 * strength ** 4),
    agc: Math.min(1, strength / 0.45),
    vTotal: builtIn + Math.sign(vKnob) * 0.10 * Math.pow(Math.abs(vKnob), 1.37),
    vLock,
    vCenter: Math.asin(builtIn / vLock) / TAU,
    vBeta: 1 - Math.exp(-1 / (1.5 * s)),
    hR: Math.sign(hKnob) * hFree / s,
    kp: kpN / s,
    humIre: clamp(m.tvHum || 0, 0, 1) * 60,
    gateAlpha: 1 - Math.exp(-1 / (6 * s)),
    chromaAlpha: 1 - Math.exp(-1 / (4 * s)),
    accGamma: 1 - Math.exp(-1 / (8 * s)),
    killerKappa: 1 - Math.exp(-1 / (15 * s)),
  };
}

// The set's colour reference: oscillator phase, ACC gain, colour killer.
class ChromaReference {
  constructor() { this.phase = 0; this.gain = 1; this.killer = 1; this.on = true; }
  step(gi, gq, k) {
    const b0 = T.BURST_AMPLITUDE;
    const mag = Math.hypot(gi, gq);
    let c = Math.cos(-this.phase), s = Math.sin(-this.phase);
    const ri = gi * c - gq * s, rq = gi * s + gq * c;
    const dot = ri * T.BURST_I + rq * T.BURST_Q;
    const cross = T.BURST_I * rq - T.BURST_Q * ri;
    if (mag > 0) this.phase += k.chromaAlpha * Math.min(1, mag / b0) * Math.atan2(cross, dot);
    c = Math.cos(-this.phase); s = Math.sin(-this.phase);
    const inPhase = (gi * c - gq * s) * T.BURST_I + (gi * s + gq * c) * T.BURST_Q;
    this.gain = clamp(this.gain + k.accGamma * (b0 / Math.max(inPhase, 0.25 * b0) - this.gain), 0.3, 3);
    this.killer += k.killerKappa * (clamp(inPhase / b0, -1, 1) - this.killer);
    if (this.on && this.killer < 0.3) this.on = false;
    else if (!this.on && this.killer > 0.5) this.on = true;
  }
}

export class Receiver {
  constructor(activeLines = ACTIVE_LINES, seed = SEED) {
    this.raster = makeRaster(activeLines);
    this.seed = seed;
    this.l = this.raster.totalLines;
    this.usPerSecond = T.LINE * this.l * T.FIELD_RATE;
    this.logCap = 4 * this.l + 64;
    this.thetaLog = new Float64Array(this.logCap);
    this.gateLog = new Float64Array(this.logCap);
    this.rows = new Float32Array(activeLines * 8);        // two RGBA texels per row, see plan()
    this.k = knobs(TV_DEFAULTS, this.raster);
    this.nominalTrigger = 0;
    this.reset();
    // where in the field a healthy, locked set's vertical oscillator fires
    this.advance(0, TV_DEFAULTS);
    this.nominalTrigger = this.triggers.length ? posmod(this.triggers[this.triggers.length - 1], this.l) : this.raster.preEqEnd + 2;
    this.reset();
  }

  reset() {
    this.r = 0;            // TV lines drawn so far
    this.theta = 0;        // the horizontal oscillator's phase error, µs
    this.vPhase = 0; this.vInteg = 0; this.vAbove = false;
    this.gateErr = 0;
    this.triggers = [];    // TV lines on which the vertical oscillator fired
    this.thetaLog.fill(0); this.gateLog.fill(0);
  }

  // seconds since time zero (negative during warm-up)
  get time() { return (this.r * T.LINE + this.theta) / this.usPerSecond - WARMUP; }

  // Run the set forward to `time` with these knobs in force since the last call.
  advance(time, master) {
    this.k = knobs(master, this.raster);
    const target = (time + WARMUP) * this.usPerSecond;
    while (this.r * T.LINE + this.theta <= target) this.step();
  }

  hum(tau) {
    if (this.k.humIre <= 0) return 0;
    const t = tau / this.usPerSecond;
    return this.k.humIre * (0.8 * Math.sin(TAU * 60 * t) + 0.3 * Math.sin(TAU * 120 * t + 0.7));
  }

  // one TV line
  step() {
    const h = T.LINE, k = this.k, seed = this.seed, r = this.r;
    const tau = r * h + this.theta;
    const j = Math.round(tau / h);                         // the signal line whose sync edge is nearest
    const edge = j * h;
    const jf = posmod(j, this.l);
    const sigmaSep = k.sigma * 0.35;
    const humNow = this.hum(tau), humShift = 0.4 * humNow;
    const syncMargin = 20 - humShift, blankMargin = 20 + humShift;
    const pDetect = sigmaSep > 0 ? phi(syncMargin / sigmaSep) : (syncMargin > 0 ? 1 : 0);
    const pNoisePeak = sigmaSep > 0 ? phi(-blankMargin / sigmaSep) : (blankMargin > 0 ? 0 : 1);

    // horizontal phase detector
    let detected = null;
    if (uni(seed, 11, r) < Math.min(1, 10 * pNoisePeak)) detected = (uni(seed, 12, r) - 0.5) * h * 0.6;
    else if (uni(seed, 13, r) < pDetect) detected = edge - tau + gauss(seed, 14, r) * sigmaSep * 0.0125 + humNow * 0.05;

    // AFC: a proportional loop around a free-running oscillator, sinusoidal detector
    let next = this.theta + h * k.hR;
    if (detected !== null) next += k.kp * (h / TAU) * Math.sin(TAU * detected / h);

    // vertical sync integrator, fed by the sync separator's output
    const duty = syncDuty(this.raster, jf);
    let measured = duty * pDetect + (1 - duty) * pNoisePeak;
    const variance = (duty * pDetect * (1 - pDetect) + (1 - duty) * pNoisePeak * (1 - pNoisePeak)) / 60;
    if (variance > 0) measured += gauss(seed, 15, r) * Math.sqrt(variance);
    this.vInteg += (measured - this.vInteg) * k.vBeta;
    let vsync = false;
    if (this.vAbove) { if (this.vInteg < 0.25) this.vAbove = false; }
    else if (this.vInteg >= 0.45) { this.vAbove = true; vsync = true; }

    // vertical oscillator, phase-locked to those pulses
    this.vPhase += 1 + (next - this.theta) / h;
    const period = this.l * (1 + k.vTotal);
    if (vsync) {
      let e = this.vPhase / period - k.vCenter;
      e -= Math.round(e);
      this.vPhase -= k.vLock * period * Math.sin(TAU * e);
    }
    if (this.vPhase >= period) {
      this.vPhase -= period;
      this.triggers.push(r);
      if (this.triggers.length > 16) this.triggers.shift();
    }

    // burst-key loop
    if (detected !== null) {
      let d = (edge - tau) - this.gateErr;
      d -= h * Math.round(d / h);
      this.gateErr += k.gateAlpha * d;
      this.gateErr -= h * Math.round(this.gateErr / h);
    }
    const slot = posmod(r, this.logCap);
    this.thetaLog[slot] = this.theta;
    this.gateLog[slot] = this.gateErr;
    this.theta = next;
    this.r = r + 1;
  }

  logged(log, tvLine, now) {
    if (tvLine < 0 || tvLine >= this.r || this.r - tvLine > this.logCap) return now;
    return log[posmod(tvLine, this.logCap)];
  }
  inRetrace(tvLine) {
    const retrace = Math.max(2, Math.round(9 * this.raster.scale));
    return this.triggers.some((t) => tvLine >= t && tvLine < t + retrace);
  }

  // What the burst gate of a TV line reads: the burst where it is on it, a stand-in
  // chroma where it lands on picture (the real one would need a read-back from the GPU).
  gate(fieldLine, start, tvLine, out) {
    const ras = this.raster, k = this.k, h = T.LINE;
    let gi = 0, gq = 0;
    for (let i = 0; i < GATE_SAMPLES; i++) {
      let u = start + T.GATE_START + (i + 0.5) / GATE_SAMPLES * (T.GATE_END - T.GATE_START);
      let line = fieldLine;
      if (u < 0) { u += h; line -= 1; } else if (u >= h) { u -= h; line += 1; if (u >= h) { u -= h; line += 1; } }
      line = posmod(line, this.l);
      if (line >= ras.postEqEnd && u >= T.BURST_START && u < T.BURST_END) {
        gi += T.BURST_I * T.BURST_AMPLITUDE * k.agc; gq += T.BURST_Q * T.BURST_AMPLITUDE * k.agc;
      } else if (line >= ras.vbiLines && u >= T.ACTIVE_START && u < T.ACTIVE_START + T.ACTIVE_LENGTH) {
        const x = line * 0.37 + u * 0.21;
        gi += 0.12 * value(this.seed, 61, x) * k.agc; gq += 0.12 * value(this.seed, 62, x) * k.agc;
      }
    }
    // normalised so a centred gate (10 of its 16 samples on the burst) reads the burst at full amplitude
    const norm = (T.GATE_END - T.GATE_START) / ((T.BURST_END - T.BURST_START) * GATE_SAMPLES);
    gi *= norm; gq *= norm;
    const n = k.sigma / 92.5 * 0.45;
    if (n > 0) { gi += gauss(this.seed, 21, tvLine) * n; gq += gauss(this.seed, 22, tvLine) * n; }
    out[0] = gi; out[1] = gq;
  }

  // The most recently completed field, as the set drew it. `rows` holds two RGBA
  // texels per picture row: (u0, signal line, hum IRE, 0) and the colour reference
  // (cos, sin, gain; gain 0 = colour killed). u0 is µs from that signal line's sync
  // edge to the TV line's start.
  plan() {
    const ras = this.raster, k = this.k, h = T.LINE, a = ras.activeLines;
    const offset = ras.vbiLines - this.nominalTrigger;
    const lastDrawn = this.r - 1;
    let scanStart = lastDrawn - offset - a + 1;
    for (let i = this.triggers.length - 1; i >= 0; i--) {
      if (this.triggers[i] + offset + a - 1 <= lastDrawn) { scanStart = this.triggers[i]; break; }
    }
    const first = scanStart + offset;
    const g = [0, 0];

    // settle the colour reference over the blanking lines above the picture
    const chroma = new ChromaReference();
    const warm = Math.max(4, Math.round(12 * ras.scale));
    for (let w = warm; w >= 1; w--) {
      const tvLine = first - w;
      if (this.inRetrace(tvLine)) continue;
      const tau = tvLine * h + this.logged(this.thetaLog, tvLine, this.theta);
      const j = Math.floor(tau / h);
      this.gate(posmod(j, this.l), tau - j * h + this.logged(this.gateLog, tvLine, this.gateErr), tvLine, g);
      chroma.step(g[0], g[1], k);
    }

    const rows = this.rows;
    let locked = true, topLine = 0;
    for (let y = 0; y < a; y++) {
      const tvLine = first + y;
      const tau = tvLine * h + this.logged(this.thetaLog, tvLine, this.theta);
      const j = Math.floor(tau / h), u0 = tau - j * h, fieldLine = posmod(j, this.l);
      if (y === 0) topLine = j;
      const hum = this.hum(tau);
      this.gate(fieldLine, u0 + this.logged(this.gateLog, tvLine, this.gateErr), tvLine, g);
      chroma.step(g[0], g[1], k);
      const ph = Math.abs(chroma.phase) < 1e-4 ? 0 : chroma.phase;
      const gain = !chroma.on ? 0 : Math.abs(chroma.gain - 1) < 1e-4 ? 1 : chroma.gain;
      // a line that starts within a whisker of its sync edge starts on it
      const slip = Math.min(u0, h - u0);
      const exact = slip < 1e-3 && posmod(u0 < h / 2 ? fieldLine : fieldLine + 1, this.l) === ras.vbiLines + y;
      if (!exact || hum !== 0 || ph !== 0 || gain !== 1) locked = false;
      const o = y * 8;
      rows[o] = exact ? 0 : u0; rows[o + 1] = exact ? ras.vbiLines + y : fieldLine; rows[o + 2] = hum; rows[o + 3] = 0;
      rows[o + 4] = Math.cos(-ph); rows[o + 5] = Math.sin(-ph); rows[o + 6] = gain; rows[o + 7] = 0;
    }
    return {
      raster: ras, rows, locked,
      fieldIndex: scanStart >>> 0,
      ccBits: this.captionBits(Math.floor(topLine / this.l)),
      noiseIre: k.sigma, pictureGain: k.agc,
    };
  }

  // Line 21: run-in start bits (0, 0, 1), then two 7-bit characters with odd parity,
  // LSB first: the row of dashes in the blanking bar when the picture rolls.
  captionBits(field) {
    const ch = (i) => {
      const c = 0x20 + Math.floor(uni(this.seed, 71, field, i) * 90);
      let ones = 0; for (let b = c; b; b >>= 1) ones += b & 1;
      return c | (ones % 2 === 0 ? 0x80 : 0);
    };
    return (0b100 | (ch(0) << 3) | (ch(1) << 11)) >>> 0;
  }
}

// The set as the renderer uses it: update(master, seconds) returns the field to draw,
// or null while every knob is healthy and the picture has settled back into lock (the
// pass is then skipped altogether). The set's clock only runs while it is in use, and
// a long gap between frames (a hidden tab) is not caught up on.
export function createTv() {
  const set = new Receiver();
  let clock = 0, last = null, settled = true;
  return {
    update(master, now) {
      const active = tvActive(master);
      const dt = last === null ? 0 : clamp(now - last, 0, 0.1);
      last = now;
      if (!active && settled) return null;
      clock += dt;
      set.advance(clock, master);
      const plan = set.plan();
      settled = plan.locked;
      return !active && settled ? null : plan;
    },
  };
}
