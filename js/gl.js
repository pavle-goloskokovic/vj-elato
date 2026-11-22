// WebGL2 compositor shared by the player and the controller previews.
//
// Each deck's video is sampled as a texture and run through a per-deck effect
// shader into its own framebuffer. The two decks are then mixed (crossfade +
// blend mode) with a feedback trail from the previous frame into a ping-pong
// framebuffer. The master's tape (a drawn VHS look) and TV set (tv.js, a simulated
// television) then play that picture, and the result is blitted to one or more
// panes of the canvas through the picture tube (scanlines, mask, curvature) with
// strobe applied. The player uses one full-window pane; the controller shows
// deck A, the output and deck B side by side at a small size.
//
// Only decks whose video can be read by WebGL are drawn here: local files
// (blob: URLs) and same-origin files. Neither Destockd's CDN nor archive.org's
// storage nodes send CORS headers on video, so streams taint WebGL and the
// stage keeps such a deck as a plain <video> layer with CSS filters instead.

import { createTv, TIMING } from './tv.js';
import { GEN_BY_ID, genShader } from './generators.js';

const VERT = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);   // one triangle covering the viewport
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const DECK_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D tex;
uniform vec2 texSize, outSize;
uniform float fitCover, zoom, rotate, hue, saturate, contrast, brightness, invert;
uniform float pixelate, rgbShift, posterize, threshold;
uniform vec2 crop;          // fraction trimmed from each side (x) and top/bottom (y): 0.125 removes 4:3 pillarbox bars
uniform float blur;         // radius in output pixels; a 12-tap disc, cheap and good enough for a VJ blur
uniform int mirror, kaleido;
uniform float halftone, dither, ledWall;   // screen grids: each sets its cell size; they layer, the picture read at the coarsest
uniform float ripple, spiral, glitch, time;
uniform int palette;        // brightness mapped onto colours: 1 duotone, 2 thermal, 3 cyanotype, 4 phosphor; hue turns them
uniform int edges;          // 1 white outlines on black, 2 outlines over the picture, 3 neon
uniform float ascii;        // a fourth screen grid: characters, denser where the picture is brighter
uniform float riso;         // three spot inks on paper, this far out of register
uniform float warp, stretchGrid, interference, grain, fisheye;
uniform float radialBlur;   // above zero streaks out from the middle, below zero spins around it
uniform float stretch;      // above zero the column at this distance from the right edge is pulled out to the edge, below zero a row to the bottom
uniform float lumalines;    // rows of lines pushed up by brightness
uniform float scanMod;      // scan lines that swell with brightness

// 5x5 glyphs, sparse to dense: space . : - + = o % @ #  (bit = row * 5 + column, row 0 on top)
const int GLYPHS[10] = int[](0, 4194304, 131200, 14336, 145536, 459200, 15255086, 27070835, 15398446, 11512810);

const float BAYER[16] = float[](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
float hash(vec2 p) {        // Dave Hoskins' hash without sine: no banding on pixel coordinates
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec2 noise2(vec2 p) {       // smooth value noise, two channels
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  vec2 a = vec2(hash(i), hash(i + 31.7)), b = vec2(hash(i + vec2(1.0, 0.0)), hash(i + vec2(1.0, 0.0) + 31.7));
  vec2 c = vec2(hash(i + vec2(0.0, 1.0)), hash(i + vec2(0.0, 1.0) + 31.7)), e = vec2(hash(i + 1.0), hash(i + 1.0 + 31.7));
  return mix(mix(a, b, f.x), mix(c, e, f.x), f.y);
}
// where grid line k of n sits on screen: evenly spaced, pushed about by amt, gliding to a new place every second
float cutAt(float k, float n, float row, float amt) {
  if (k <= 0.0) return 0.0;
  if (k >= n) return 1.0;
  float tick = floor(time), f = smoothstep(0.0, 0.35, fract(time));
  float j = mix(hash(vec2(k + row * 17.0, tick)), hash(vec2(k + row * 17.0, tick + 1.0)), f);
  return (k + (j - 0.5) * 0.9 * amt) / n;
}
// screen position -> picture position along one axis of the stretchy grid
float unstretch(float x, float row, float amt) {
  const float N = 5.0;
  for (float k = 0.0; k < N; k++) {
    float a = cutAt(k, N, row, amt), b = cutAt(k + 1.0, N, row, amt);
    if (x < b || k == N - 1.0) return (k + clamp((x - a) / max(b - a, 1e-4), 0.0, 1.0)) / N;
  }
  return x;
}
vec3 paletteMap(float l) {
  l = clamp(l, 0.0, 1.0);
  if (palette == 1) return mix(vec3(0.12, 0.0, 0.38), vec3(1.0, 0.86, 0.25), l);
  if (palette == 2) {
    if (l < 0.25) return mix(vec3(0.02, 0.0, 0.15), vec3(0.45, 0.0, 0.6), l * 4.0);
    if (l < 0.5) return mix(vec3(0.45, 0.0, 0.6), vec3(0.95, 0.15, 0.1), (l - 0.25) * 4.0);
    if (l < 0.75) return mix(vec3(0.95, 0.15, 0.1), vec3(1.0, 0.8, 0.1), (l - 0.5) * 4.0);
    return mix(vec3(1.0, 0.8, 0.1), vec3(1.0), (l - 0.75) * 4.0);
  }
  if (palette == 3) return mix(vec3(0.04, 0.17, 0.42), vec3(0.93, 0.96, 1.0), l);
  return l * vec3(0.15, 1.0, 0.35) + pow(l, 4.0) * 0.4;
}

const vec2 TAPS[12] = vec2[](
  vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457), vec2(-0.203, 0.621),
  vec2(0.962, -0.195), vec2(0.473, -0.480), vec2(0.519, 0.767), vec2(0.185, -0.893),
  vec2(0.507, 0.064), vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));

const float PI = 3.14159265;

// t is in picture space (0..1 over the cropped picture)
vec4 sampleTex(vec2 t) {
  if (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) return vec4(0.0);
  return texture(tex, crop + t * (1.0 - 2.0 * crop));
}
vec3 hueRotate(vec3 c, float a) {
  const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 yiq = toYIQ * c;
  float s = sin(a), co = cos(a);
  yiq.yz = mat2(co, -s, s, co) * yiq.yz;
  return toRGB * yiq;
}

void main() {
  float ca = outSize.x / outSize.y;
  float ta = (texSize.x * (1.0 - 2.0 * crop.x)) / (texSize.y * (1.0 - 2.0 * crop.y));
  vec2 uv = vUv;

  // screen grids: the picture is read once, at the middle of the coarsest active cell; every active grid
  // then shapes its own cell after the colour chain, so they layer (LED blocks made of dots, dithered dots)
  vec2 scr = vUv * outSize;
  float k720 = outSize.y / 720.0, coarse = 0.0;
  vec2 ditI = vec2(0.0), ledF = vec2(0.0), dotF = vec2(0.0);
  float dotPx = 1.0;
  if (dither > 0.0) {
    float px = floor(mix(2.0, 9.0, dither) * k720 + 0.5);
    ditI = floor(scr / px);
    coarse = px; uv = (ditI + 0.5) * px / outSize;
  }
  if (ledWall > 0.0) {
    float px = mix(8.0, 70.0, ledWall) * k720;
    vec2 sz = vec2(px * 1.5, px), q = scr / sz, i = floor(q);
    ledF = q - i - 0.5;
    if (px > coarse) { coarse = px; uv = (i + 0.5) * sz / outSize; }
  }
  if (halftone > 0.0) {
    dotPx = mix(5.0, 40.0, halftone) * k720;
    const mat2 R = mat2(0.7071, 0.7071, -0.7071, 0.7071);       // the screen is turned 45 degrees, as in print
    vec2 q = R * scr / dotPx, i = floor(q);
    dotF = q - i - 0.5;
    if (dotPx > coarse) { coarse = dotPx; uv = transpose(R) * ((i + 0.5) * dotPx) / outSize; }
  }
  vec2 chrF = vec2(0.0);
  if (ascii > 0.0) {
    float px = mix(8.0, 48.0, ascii) * k720;
    vec2 sz = vec2(px * 0.7, px), q = scr / sz, i = floor(q);
    chrF = q - i;
    if (px > coarse) { coarse = px; uv = (i + 0.5) * sz / outSize; }
  }

  if (stretch > 0.0) uv.x = min(uv.x, 1.0 - stretch);
  else if (stretch < 0.0) uv.y = max(uv.y, -stretch);
  if (stretchGrid > 0.0) {          // rows first, then each row cuts its own columns
    float y = unstretch(uv.y, 0.0, stretchGrid);
    uv = vec2(unstretch(uv.x, 1.0 + floor(y * 5.0), stretchGrid), y);
  }
  if (interference > 0.0) uv.x += sin(vUv.y * 40.0 + time * 6.0) * 0.006 * interference;

  // band glitch: the picture is cut into bands, re-rolled eight times a second; a hit band jumps sideways,
  // repeats a crop of itself or splits its colours
  float split = rgbShift * 0.04;
  if (glitch > 0.0) {
    float tick = floor(time * 8.0);
    float bh = 0.03 + 0.13 * hash(vec2(tick, 1.0));
    float band = floor(uv.y / bh + hash(vec2(tick, 2.0)));
    if (hash(vec2(band, tick)) < glitch * 0.8) {
      float r2 = hash(vec2(band + 7.0, tick)), r3 = hash(vec2(band + 13.0, tick));
      uv.x += (r2 - 0.5) * 0.6 * glitch;
      if (r3 < 0.4) { float w = 0.04 + 0.2 * r2; uv.x = r2 * (1.0 - w) + mod(uv.x, w); }
      else if (r3 > 0.65) split += 0.05 * glitch;
      uv.x = fract(uv.x);
    }
  }

  vec2 d = (uv - 0.5) * vec2(ca, 1.0);
  if (fisheye != 0.0) {             // lens bulge: the middle swells, the rim crowds in; below zero the reverse. Top and bottom edges stay put
    float k = fisheye > 0.0 ? fisheye * 4.0 : fisheye * 0.8;
    d *= (1.0 + k * dot(d, d)) / (1.0 + k * 0.25);
  }
  if (spiral != 0.0) {              // wrung around the middle, the rim held still
    float k = max(0.0, 1.0 - length(d) / 0.9);
    float a = spiral * 6.0 * k * k, sn = sin(a), cs = cos(a);
    d = mat2(cs, -sn, sn, cs) * d;
  }
  if (ripple > 0.0) {               // rings spreading from the middle
    float r = length(d);
    d += (r > 0.0 ? d / r : vec2(0.0)) * sin(r * 36.0 - time * 5.0) * 0.035 * ripple;
  }
  if (warp > 0.0) d += (noise2(d * 2.5 + vec2(time * 0.25, -time * 0.18)) - 0.5) * 0.45 * warp;
  if (kaleido >= 2) {
    float seg = 2.0 * PI / float(kaleido);
    float a = atan(d.y, d.x), r = length(d);
    a = mod(a, seg); a = abs(a - seg * 0.5);
    d = r * vec2(cos(a), sin(a));
  }
  if (rotate != 0.0) { float s = sin(rotate), c = cos(rotate); d = mat2(c, -s, s, c) * d; }
  d /= zoom;
  uv = d / vec2(ca, 1.0) + 0.5;
  if (mirror == 1 || mirror == 3) uv.x = 0.5 - abs(uv.x - 0.5);
  if (mirror == 2 || mirror == 3) uv.y = 0.5 - abs(uv.y - 0.5);
  if (pixelate > 0.0) {
    float n = mix(400.0, 8.0, pixelate);
    vec2 cells = vec2(n, n / ca);
    uv = (floor(uv * cells) + 0.5) / cells;
  }

  vec2 s = vec2(1.0);
  if ((ca > ta) != (fitCover > 0.5)) s.x = ca / ta; else s.y = ta / ca;
  vec2 t = (uv - 0.5) * s + 0.5;

  vec4 c = sampleTex(t);
  float lineMask = 1.0;
  if (lumalines > 0.0) {            // ridge lines, front to back: the first line this pixel sits on is drawn, anything under a ridge is hidden
    float n = mix(90.0, 24.0, lumalines), h = 1.0 / n, amp = 3.5 * h;
    float j0 = floor(t.y * n);
    vec4 hit = vec4(0.0); lineMask = 0.0;
    for (float j = 4.0; j >= 0.0; j--) {
      float base = (j0 - j + 0.5) * h;
      vec4 sm = sampleTex(vec2(t.x, base));
      float top = base + amp * luma(sm.rgb) * sm.a;
      if (abs(t.y - top) < h * 0.16) { hit = sm; lineMask = 1.0; break; }
      if (t.y < top) break;
    }
    c = vec4(hit.rgb, c.a);
  }
  if (radialBlur != 0.0) {
    vec4 acc = vec4(0.0);
    vec2 p = (t - 0.5) * vec2(ta, 1.0);
    for (float i = 0.0; i < 14.0; i++) {
      float f = (i + hash(scr + i)) / 14.0 * abs(radialBlur);
      vec2 q = p * (1.0 - 0.35 * f);
      if (radialBlur < 0.0) { float a = 0.5 * f, sn = sin(a), cs = cos(a); q = mat2(cs, -sn, sn, cs) * p; }
      acc += sampleTex(q / vec2(ta, 1.0) + 0.5);
    }
    c = vec4(acc.rgb / 14.0, max(c.a, acc.a / 14.0));
  }
  if (riso > 0.0) {                 // each ink is one channel's shadow, printed a little off, in four strengths
    vec2 off = vec2(0.004 + 0.02 * riso, 0.002 + 0.008 * riso);
    vec3 dens = 1.0 - vec3(sampleTex(t - off).r, c.g, sampleTex(t + off).b);
    dens = floor(dens * 3.0 + 0.5 + (hash(scr) - 0.5) * 0.5) / 3.0;
    vec3 paper = vec3(0.96, 0.94, 0.88);
    c.rgb = paper * mix(vec3(1.0), vec3(0.0, 0.47, 0.75), dens.r) * mix(vec3(1.0), vec3(1.0, 0.28, 0.5), dens.g) * mix(vec3(1.0), vec3(1.0, 0.9, 0.1), dens.b);
  }
  if (split > 0.0) {
    vec2 sh = vec2(split, 0.0);
    c.r = sampleTex(t + sh).r;
    c.b = sampleTex(t - sh).b;
  }
  if (blur > 0.0) {
    vec2 r = blur * 2.0 / outSize * s;          // output pixels -> picture uv, through the fit scale
    vec4 acc = vec4(0.0);
    for (int i = 0; i < 12; i++) acc += sampleTex(t + TAPS[i] * r);
    acc /= 12.0;
    c = vec4(mix(acc.rgb, c.rgb, 0.0), max(c.a, acc.a));
  }
  if (c.a <= 0.0) { o = vec4(0.0); return; }

  vec3 col = c.rgb * brightness;
  col = (col - 0.5) * contrast + 0.5;
  float l = luma(col);
  col = mix(vec3(l), col, saturate);
  if (edges > 0) {                  // brightness gradient over a 3-pixel cross
    vec2 e = 1.5 / outSize * s;
    vec2 g = vec2(luma(sampleTex(t + vec2(e.x, 0.0)).rgb) - luma(sampleTex(t - vec2(e.x, 0.0)).rgb),
                  luma(sampleTex(t + vec2(0.0, e.y)).rgb) - luma(sampleTex(t - vec2(0.0, e.y)).rgb));
    float line = clamp(length(g) * 5.0 * contrast * brightness, 0.0, 1.0);
    if (edges == 1) col = vec3(line);
    else if (edges == 2) col = mix(col, vec3(1.0), line);
    else col = line * 1.6 * mix(vec3(0.62, 0.2, 1.0), vec3(0.1, 0.95, 1.0), 0.5 + 0.5 * sin(atan(g.y, g.x) * 2.0));
  }
  if (palette > 0) col = paletteMap(luma(col));
  if (hue != 0.0) col = hueRotate(col, hue);
  if (posterize >= 2.0) col = floor(col * posterize + 0.5) / posterize;
  if (threshold > 0.0) col = vec3(step(threshold, luma(col)));
  col = clamp(col, 0.0, 1.0);
  if (lumalines > 0.0) col = lineMask * mix(col, col / max(max(col.r, max(col.g, col.b)), 0.02), 0.6);
  if (scanMod > 0.0) {              // one line per row, as thick as the picture is bright
    float n = mix(160.0, 30.0, scanMod), w = pow(luma(col), 0.7) * 0.5;
    float e = abs(fract(vUv.y * n) - 0.5), aa = n / outSize.y;
    col = col / max(luma(col), 0.05) * 0.8 * smoothstep(w + aa, w - aa, e);
    col = min(col, vec3(1.0));
  }
  if (interference > 0.0) {         // lines and rainbow fringes whose phase rides on the brightness
    float ph = vUv.y * 180.0 + luma(col) * 14.0 + sin(vUv.y * 23.0 + time * 3.0) * 3.0 + time * 7.0;
    float ln = 0.5 + 0.5 * sin(ph);
    vec3 rb = 0.5 + 0.5 * cos(ph * 0.21 + vec3(0.0, 2.1, 4.2));
    col = mix(col, col * (0.35 + 0.9 * ln) + rb * ln * 0.45 * (0.3 + luma(col)), interference);
  }
  float v = max(col.r, max(col.g, col.b));          // dot size comes from the brightness before the dither
  if (dither > 0.0) {               // ordered dither down to eight colours
    ivec2 ci = ivec2(ditI) & 3;
    col = step(vec3((BAYER[ci.y * 4 + ci.x] + 0.5) / 16.0), col);
  }
  if (halftone > 0.0) {             // dots that grow with brightness, in the picture's own hue (or the dither's colours)
    float aa = 1.0 / dotPx;
    if (dither <= 0.0) col = mix(col, col / max(v, 0.02), smoothstep(0.05, 0.3, v));
    col *= smoothstep(aa, -aa, length(dotF) - sqrt(v) * 0.72);
  }
  if (ledWall > 0.0) {              // glowing blocks with dark seams
    float m = smoothstep(0.5, 0.36, max(abs(ledF.x), abs(ledF.y)));
    col *= mix(0.06, 1.25, m);
  }
  if (ascii > 0.0) {                // the glyph is picked by brightness and drawn in the picture's hue
    ivec2 g = ivec2(floor(chrF * vec2(6.0, 6.5) - vec2(0.5, 0.75)));
    int on = (g.x >= 0 && g.x < 5 && g.y >= 0 && g.y < 5) ? (GLYPHS[int(clamp(v * 10.0, 0.0, 9.0))] >> ((4 - g.y) * 5 + g.x)) & 1 : 0;
    col = mix(col, col / max(v, 0.02), smoothstep(0.05, 0.3, v)) * float(on);
  }
  if (grain > 0.0) col += (hash(scr + floor(time * 24.0) * 7.31) - 0.5) * 0.6 * grain;
  col = mix(col, 1.0 - col, invert);
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const MIX_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D texA, texB, prev;
uniform float wA, wB, feedback, fbZoom, fbRotate, fbHue;
uniform float fbKey;        // luma key level: the mix stays in front where it is brighter, the trail covers it where darker
uniform float fbTilt;       // the loop's camera turned sideways: one side of the trail recedes
uniform float fbBlur;       // softening inside the loop, in output pixels (x3); it compounds every pass
uniform vec2 fbCentre;      // the vanishing point, as an offset from the middle of the picture
uniform int blend;
uniform vec2 outSize;

vec4 prevAt(vec2 t) {
  return (t.x < 0.0 || t.x > 1.0 || t.y < 0.0 || t.y > 1.0) ? vec4(0.0) : texture(prev, t);
}

vec3 blendFn(vec3 a, vec3 b) {
  if (blend == 1) return 1.0 - (1.0 - a) * (1.0 - b);
  if (blend == 2) return a * b;
  if (blend == 3) return abs(a - b);
  if (blend == 4) return max(a, b);
  if (blend == 5) return min(a, b);
  if (blend == 6) return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a));
  if (blend == 7) return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, b));
  if (blend == 8) return a + b - 2.0 * a * b;
  if (blend == 9) return min(a + b, 1.0);
  return b;
}
vec3 hueRotate(vec3 c, float a) {
  const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 yiq = toYIQ * c; float s = sin(a), co = cos(a);
  yiq.yz = mat2(co, -s, s, co) * yiq.yz; return toRGB * yiq;
}

void main() {
  vec4 a = texture(texA, vUv); a.a *= wA;
  vec4 b = texture(texB, vUv); b.a *= wB;
  vec3 col = a.rgb * a.a * (1.0 - b.a) + mix(b.rgb, blendFn(a.rgb, b.rgb), a.a) * b.a;   // premultiplied
  float al = a.a + b.a * (1.0 - a.a);

  if (feedback > 0.0) {
    float ca = outSize.x / outSize.y;
    vec2 centre = vec2(0.5) + fbCentre;
    vec2 d = (vUv - centre) * vec2(ca, 1.0);
    d /= max(0.05, 1.0 + fbTilt * d.x);
    float s = sin(fbRotate), c = cos(fbRotate);
    d = mat2(c, -s, s, c) * d / fbZoom;
    vec2 fuv = d / vec2(ca, 1.0) + centre;
    vec4 p = prevAt(fuv);
    if (fbBlur > 0.0) {
      vec2 r = fbBlur * 3.0 / outSize;
      p = (p * 2.0 + prevAt(fuv + r) + prevAt(fuv - r) + prevAt(fuv + vec2(r.x, -r.y)) + prevAt(fuv + vec2(-r.x, r.y))) / 6.0;
    }
    p *= feedback;
    if (fbHue != 0.0 && p.a > 0.0) p.rgb = clamp(hueRotate(p.rgb / p.a, fbHue), 0.0, 1.0) * p.a;
    vec3 lit = max(col, p.rgb); float litA = max(al, p.a);        // the trail shows where it is brighter
    if (fbKey > 0.0) {
      // keyed: below the key level the trail lies over the mix instead, so a bright
      // subject stays solid in front of a tunnel of its own copies
      float k = smoothstep(fbKey - 0.06, fbKey + 0.06, dot(col, vec3(0.299, 0.587, 0.114)));
      col = mix(p.rgb + col * (1.0 - p.a), lit, k);
      al = mix(p.a + al * (1.0 - p.a), litA, k);
    } else { col = lit; al = litA; }
  }
  o = vec4(col, al);
}`;

// The TV set's screen: every pixel is scanned from wherever in the signal the set's
// beam was when it drew that spot (tv.js simulates where), then ghost, weak-signal
// gain, hum and snow are added and the colour is decoded against the row's colour
// reference. Ported from NTSCRT's glitch.wgsl (MIT, (c) 2026 Finn McKenty; notice in
// tv.js). Times are µs along a 63.556 µs scan line.
const TV_FRAG = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv; out vec4 o;
uniform sampler2D tex;      // the mixed picture, premultiplied
uniform sampler2D rows;     // per picture row: (u0, signal line, hum IRE, -) and (ref cos, ref sin, colour gain, -)
uniform int activeLines, vbiLines, totalLines, preEqEnd, vsyncEnd, postEqEnd;
uniform uint ccBits, fieldIndex;
uniform float ghostLevel, ghostDelay, ghostCos, ghostSin, tvBright, pictureGain, noiseIRE;

const float LINE = ${TIMING.LINE};
const float SYNC_END = ${TIMING.SYNC};
const float ACT_S = ${TIMING.ACTIVE_START};
const float ACT_L = ${TIMING.ACTIVE_LENGTH};
const float EQ_PULSE = ${TIMING.EQUALIZING_PULSE};
const float BROAD = ${TIMING.BROAD_PULSE};
const uint SEED = 0x9E3779B9u;

vec3 rgb2yiq(vec3 c) {
  return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312)));
}
vec3 yiq2rgb(vec3 y) {
  return vec3(y.x + 0.9561706854 * y.y + 0.6214325663 * y.z,
              y.x - 0.2726886023 * y.y - 0.6468132370 * y.z,
              y.x - 1.1037440822 * y.y + 1.7006230947 * y.z);
}
float ire2y(float ire) { return (ire - 7.5) / 92.5; }

uint hash4(uint a, uint b, uint c, uint d) {
  uint h = a * 0x8DA6B343u ^ b * 0xD8163841u ^ c * 0xCB1AB31Fu ^ d * 0x165667B1u;
  h ^= h >> 15u; h *= 0x2C1B3C6Du; h ^= h >> 12u; h *= 0x297A2D39u; h ^= h >> 15u;
  return h;
}
float uni(uint a, uint b, uint c, uint d) { return (float(hash4(a, b, c, d) >> 8u) + 0.5) * (1.0 / 16777216.0); }
float gauss(uint a, uint b, uint c, uint d) {
  return sqrt(-2.0 * log(uni(a, b, c, d))) * cos(6.2831853 * uni(a ^ 0x5bd1e995u, b, c, d + 7u));
}

// where in the signal a moment of a TV line falls
void locate(inout int line, inout float u) {
  if (u < 0.0) { u += LINE; line -= 1; }
  else if (u >= LINE) { u -= LINE; line += 1; if (u >= LINE) { u -= LINE; line += 1; } }
  line -= totalLines * int(floor(float(line) / float(totalLines)));
}

// line 21: 7 cycles of clock run-in at 503.5 kHz, then 19 bits of caption data
float captionIRE(float u) {
  float t = u - 10.5, period = 1.986;
  if (t < 0.0) return 0.0;
  if (t < 7.0 * period) return 25.0 - 25.0 * cos(6.2831853 * t / period);
  float b = (t - 7.0 * period) / period;
  int k = int(floor(b));
  if (k < 0 || k >= 19) return 0.0;
  float on = float((ccBits >> uint(k)) & 1u);
  float prev = k > 0 ? float((ccBits >> uint(k - 1)) & 1u) : 0.0;
  return 50.0 * mix(prev, on, smoothstep(0.0, 0.25, b - float(k)));
}

// What the signal carries at (line, u): Y'IQ on the decoder's scale, and the picture's
// alpha (blanking and sync are opaque). fy is how far down its row the pixel sits, so
// the picture keeps its own vertical resolution inside each of the set's lines.
vec4 signalAt(int line, float u, float fy) {
  float halfLine = LINE * 0.5, ire = 0.0;
  if (line < vbiLines) {
    if (line < preEqEnd || (line >= vsyncEnd && line < postEqEnd)) {
      if (u < EQ_PULSE || (u >= halfLine && u < halfLine + EQ_PULSE)) ire = -40.0;
    } else if (line < vsyncEnd) {
      if (u < BROAD || (u >= halfLine && u < halfLine + BROAD)) ire = -40.0;
    } else {
      if (u < SYNC_END) ire = -40.0;
      else if (line == vbiLines - 1 && u >= ACT_S && u < ACT_S + ACT_L) ire = captionIRE(u);
    }
    return vec4(ire2y(ire), 0.0, 0.0, 1.0);
  }
  if (u < SYNC_END) return vec4(ire2y(-40.0), 0.0, 0.0, 1.0);
  if (u < ACT_S || u >= ACT_S + ACT_L) return vec4(ire2y(0.0), 0.0, 0.0, 1.0);
  vec4 c = texture(tex, vec2((u - ACT_S) / ACT_L, 1.0 - (float(line - vbiLines) + fy) / float(activeLines)));
  return vec4(rgb2yiq(c.rgb), c.a);
}

void main() {
  float yTop = (1.0 - vUv.y) * float(activeLines);
  int ry = clamp(int(floor(yTop)), 0, activeLines - 1);
  float fy = yTop - float(ry);
  vec4 rw = texelFetch(rows, ivec2(0, ry), 0);
  vec3 rc = texelFetch(rows, ivec2(1, ry), 0).xyz;

  int line = int(rw.y);
  float u = rw.x + ACT_S + vUv.x * ACT_L;
  locate(line, u);
  vec4 s = signalAt(line, u, fy);
  vec3 yiq = s.xyz;

  // multipath: the same signal again, later, possibly inverted
  if (ghostLevel != 0.0) {
    float ug = u - ghostDelay; int gl = line;
    if (ug < 0.0) { ug += LINE; gl = gl > 0 ? gl - 1 : totalLines - 1; }
    vec3 g = signalAt(gl, ug, fy).xyz;
    yiq.x += ghostLevel * (g.x - ire2y(0.0));
    yiq.yz += ghostLevel * vec2(g.y * ghostCos - g.z * ghostSin, g.y * ghostSin + g.z * ghostCos);
  }

  // AGC running out of gain: everything shrinks toward blanking
  if (pictureGain != 1.0) {
    yiq.x = ire2y((7.5 + 92.5 * yiq.x) * pictureGain);
    yiq.yz *= pictureGain;
  }

  yiq.x += rw.z / 92.5;      // hum

  // Snow with the decoder's spectrum, on a 640x480 grid whatever the render size. The
  // chroma noise is band-limited: a run of uniform draws stands in for NTSCRT's run of
  // Gaussian ones (same variance, a third of the work).
  if (noiseIRE > 0.0) {
    float n = noiseIRE / 92.5;
    uint nx = uint(vUv.x * 640.0), ny = uint((1.0 - vUv.y) * 480.0) * 3u;
    yiq.x += gauss(SEED, fieldIndex, nx, ny) * n;
    float ni = 0.0, nq = 0.0;
    for (uint k = 0u; k < 5u; k++) ni += uni(SEED ^ 0x1234u, fieldIndex, nx + k, ny + 1u);
    for (uint k = 0u; k < 10u; k++) nq += uni(SEED ^ 0x4321u, fieldIndex, nx + k, ny + 2u);
    yiq.y += (ni - 2.5) * 1.5492 * n * 0.35;
    yiq.z += (nq - 5.0) * 1.0954 * n * 0.25;
  }

  // decode chroma against the row's reference
  yiq.yz = vec2(yiq.y * rc.x - yiq.z * rc.y, yiq.y * rc.y + yiq.z * rc.x) * rc.z;

  // brightness lowers the tube's cutoff: blanking and sync become visible
  if (tvBright > 0.0) {
    float cutoff = 7.5 - 47.5 * tvBright;
    yiq.x = (7.5 + 92.5 * yiq.x - cutoff) / (100.0 - cutoff);
    yiq.yz *= 92.5 / (100.0 - cutoff);
  }

  vec3 rgb = clamp(yiq2rgb(yiq), 0.0, 1.0);
  o = vec4(rgb, max(s.a, max(rgb.r, max(rgb.g, rgb.b))));     // stays premultiplied over a transparent picture
}`;

const OUT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D tex;
uniform float gain, premultiply;
uniform float crt, crtCurve;     // the picture tube: scanlines, phosphor stripes and vignette; bulge of the glass
uniform vec2 paneSize;           // canvas pixels
void main() {
  vec2 uv = vUv;
  float inside = 1.0;
  if (crtCurve > 0.0) {
    // bulging glass: the edges' middles stay put, the corners pull in; black outside
    vec2 d = uv * 2.0 - 1.0;
    d *= 1.0 + crtCurve * 0.18 * d.yx * d.yx;
    uv = d * 0.5 + 0.5;
    vec2 px = (1.0 - abs(d)) * paneSize * 0.5;
    inside = clamp(min(px.x, px.y), 0.0, 1.0);
  }
  vec4 c = texture(tex, uv);
  if (premultiply > 0.5) c.rgb *= c.a;
  if (crt > 0.0) {
    // 240 scanlines, drawn at the canvas's own pixels; they fade out where a line
    // would get fewer than about 3 pixels (the small preview) instead of turning to moire
    float a = crt * 0.7 * smoothstep(1.5, 3.0, paneSize.y / 240.0);
    float w = 0.5 - 0.5 * cos(6.2831853 * uv.y * 240.0);
    c.rgb *= (1.0 - a * (1.0 - w)) * (1.0 + 0.5 * a);
    // aperture grille: one phosphor stripe per canvas pixel
    float b = crt * 0.3;
    vec3 mask = vec3(1.0 - b);
    int m = int(gl_FragCoord.x) % 3;
    if (m == 0) mask.r = 1.0; else if (m == 1) mask.g = 1.0; else mask.b = 1.0;
    c.rgb *= mask * (1.0 + 0.6 * b);
    vec2 v = uv * 2.0 - 1.0;
    c.rgb *= 1.0 - crt * 0.1 * dot(v, v);
    c.rgb = min(c.rgb, vec3(c.a));
  }
  if (crtCurve > 0.0) c = mix(vec4(0.0, 0.0, 0.0, 1.0), c, inside);
  o = c * gain;
}`;

// A worn VHS tape, drawn rather than simulated (NTSCRT's VCR stage records and plays
// a real FM signal, which is far too heavy for live use): soft luma, colour smeared,
// late and a line low, tape noise, line jitter, dropouts, the head-switching lines
// hooked sideways at the bottom, and with "track" a band of mistracking noise that
// drifts up the picture. Works on a 640x240 tape raster whatever the render size.
const VHS_FRAG = `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv; out vec4 o;
uniform sampler2D tex;      // the mixed picture, premultiplied
uniform float vhs, track, time;
uniform uint field;

const float LINES = 240.0;
const vec3 TO_Y = vec3(0.299, 0.587, 0.114), TO_I = vec3(0.596, -0.274, -0.322), TO_Q = vec3(0.211, -0.523, 0.312);

uint hash3(uint a, uint b, uint c) {
  uint h = a * 0x8DA6B343u ^ b * 0xD8163841u ^ c * 0xCB1AB31Fu;
  h ^= h >> 15u; h *= 0x2C1B3C6Du; h ^= h >> 12u; h *= 0x297A2D39u; h ^= h >> 15u;
  return h;
}
float rnd(uint a, uint b, uint c) { return float(hash3(a, b, c) >> 8u) * (1.0 / 16777216.0); }
vec4 pic(vec2 t) { return (t.x < 0.0 || t.x > 1.0) ? vec4(0.0) : texture(tex, t); }

void main() {
  float yTop = 1.0 - vUv.y;
  uint line = uint(yTop * LINES);
  vec2 px = vec2(1.0 / 640.0, 1.0 / LINES);

  // mistracking: a band that drifts up the picture, wider the further off the heads are
  float band = 0.0;
  if (track > 0.0) {
    float dist = abs(yTop - fract(0.9 - time * 0.04));
    dist = min(dist, 1.0 - dist);
    band = track * (1.0 - smoothstep(0.0, 0.03 + 0.10 * track, dist));
  }

  // time base: every line a little off, the band's lines a lot, and the last six
  // lines, read after the heads switch, hooked sideways
  float jit = rnd(line, field, 1u) - 0.5;
  float sw = float(line) >= LINES - 6.0 ? vhs : 0.0;
  float shift = vhs * (0.0012 * jit + 0.0008 * sin(yTop * 9.0 + time * 2.3))
              + band * 0.06 * (rnd(line, field, 2u) - 0.3)
              + sw * (0.035 + 0.02 * jit);
  vec2 uv = vec2(vUv.x - shift, vUv.y);

  // luma a little soft; chroma far softer, late and a line low
  vec4 c0 = pic(uv);
  vec2 lw = vec2(vhs * 1.5 * px.x, 0.0);
  float Y = dot((c0.rgb * 2.0 + pic(uv - lw).rgb + pic(uv + lw).rgb) * 0.25, TO_Y);
  vec2 iq = vec2(0.0);
  for (int i = 0; i < 5; i++) {
    vec3 s = pic(uv + vec2((float(i) - 3.0) * vhs * 5.0 * px.x, vhs * px.y)).rgb;
    iq += vec2(dot(s, TO_I), dot(s, TO_Q));
  }
  iq *= 0.2;

  // tape noise: fine in the luma, in coarse streaks in the colour
  uint nx = uint(vUv.x * 640.0), row = line * 7u;
  Y += (rnd(nx, row + 3u, field) + rnd(nx + 1u, row + 3u, field) - 1.0) * (0.05 * vhs + 0.5 * band);
  uint cx = uint(vUv.x * 40.0);
  iq += (vec2(rnd(cx, row + 4u, field), rnd(cx, row + 5u, field)) - 0.5) * 0.06 * vhs;
  iq *= (1.0 - 0.15 * vhs) * (1.0 - band);

  // dropouts: white dashes, rare on the tape, thick in the band and on the switching lines
  if (rnd(line, field, 9u) < 0.004 * vhs + 0.5 * band + 0.3 * sw) {
    float t = (vUv.x - rnd(line, field, 10u)) / (0.03 + 0.25 * rnd(line, field, 11u));
    if (t > 0.0 && t < 1.0) Y = mix(Y, 1.0, (1.0 - t) * 0.8);
  }

  Y = Y * (1.0 - 0.06 * vhs) + 0.03 * vhs;          // milky blacks
  vec3 rgb = clamp(vec3(Y + 0.9561706854 * iq.x + 0.6214325663 * iq.y,
                        Y - 0.2726886023 * iq.x - 0.6468132370 * iq.y,
                        Y - 1.1037440822 * iq.x + 1.7006230947 * iq.y), 0.0, 1.0);
  o = vec4(rgb, max(c0.a, max(rgb.r, max(rgb.g, rgb.b))));
}`;

// Crossfader curve. With the normal blend, B simply sits on top of A, so a
// linear fade is what you expect: 50 % shows half of each. With the other
// blends both decks contribute all the way through, so both are at full
// strength in the middle and only the outer halves fade.
export function crossfadeWeights(x, blend) {
  x = Math.min(1, Math.max(0, x || 0));
  if (!blend || blend === 'normal') return [1 - x, x];
  return [Math.min(1, 2 * (1 - x)), Math.min(1, 2 * x)];
}

export const BLEND_INDEX = {
  normal: 0, screen: 1, multiply: 2, difference: 3, lighten: 4, darken: 5,
  overlay: 6, 'hard-light': 7, exclusion: 8, add: 9,
};

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true });
  if (!gl) return null;

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }
  function program(frag) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); uniforms[u.name] = gl.getUniformLocation(p, u.name); }
    return { p, u: uniforms };
  }
  const deckProg = program(DECK_FRAG), mixProg = program(MIX_FRAG), outProg = program(OUT_FRAG), tvProg = program(TV_FRAG), vhsProg = program(VHS_FRAG);
  const vao = gl.createVertexArray();

  function texture() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function target(w, h) {
    const t = texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return { t, fb, w, h };
  }

  const videoTex = { A: texture(), B: texture() };
  const videoSize = { A: [16, 9], B: [16, 9] };

  // the TV set and its per-row table (float texels, fetched, never filtered)
  const tv = createTv();
  const rowsTex = texture();
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  // Generators (generators.js): a deck's picture drawn by a shader into genFbo, which the deck
  // pass then reads in place of the video texture. Programs are compiled on first use.
  const genProgs = {};
  const genImg = { A: { t: texture(), stamp: null }, B: { t: texture(), stamp: null }, thumb: { t: texture(), stamp: null } };
  let genFbo = null, thumbFbo = null;
  function genProgram(id) {
    if (!(id in genProgs)) {
      try { genProgs[id] = program(genShader(GEN_BY_ID[id])); }
      catch (e) { console.error('generator ' + id + ' failed to compile', e); genProgs[id] = null; }
    }
    return genProgs[id];
  }
  // g: { id, time, a, b, c, image?: { el, w, h, stamp } }; slot: whose picture texture to use
  function drawGen(fbo, slot, g) {
    const prog = GEN_BY_ID[g.id] ? genProgram(g.id) : null;
    if (!prog) return false;
    const im = genImg[slot];
    let has = false;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, im.t);
    if (g.image) {
      if (im.stamp !== g.image.stamp) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, g.image.el); im.stamp = g.image.stamp; }
        catch (e) { im.stamp = null; }
        finally { gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); }
      }
      has = im.stamp === g.image.stamp;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
    gl.viewport(0, 0, fbo.w, fbo.h);
    gl.useProgram(prog.p);
    const u = prog.u;
    gl.uniform1i(u.img, 0);
    gl.uniform1f(u.hasImg, has ? 1 : 0);
    gl.uniform2f(u.imgSize, has ? g.image.w : 1, has ? g.image.h : 1);
    gl.uniform2f(u.size, fbo.w, fbo.h);
    gl.uniform1f(u.time, g.time);
    gl.uniform1f(u.a, g.a ?? 0.5); gl.uniform1f(u.b, g.b ?? 0.5); gl.uniform1f(u.c, g.c ?? 0.5);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }
  // One still of a generator for its library card: RGBA bytes, top row first.
  function genThumb(g, w, h) {
    if (!thumbFbo || thumbFbo.w !== w || thumbFbo.h !== h) thumbFbo = target(w, h);
    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    if (!drawGen(thumbFbo, 'thumb', g)) return null;
    const px = new Uint8Array(w * h * 4), out = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return out;
  }

  let W = 0, H = 0, deckFbo = null, ping = null, pingIndex = 0, tvFbo = null, vhsFbo = null;
  // Internal render size (the framebuffers). The canvas itself may be larger
  // or smaller; panes are scaled on blit.
  function resize(w, h) {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (w === W && h === H) return;
    W = w; H = h;
    deckFbo = { A: target(w, h), B: target(w, h) };
    genFbo = { A: target(w, h), B: target(w, h) };
    ping = [target(w, h), target(w, h)];
    tvFbo = target(w, h);
    vhsFbo = target(w, h);
  }
  function setCanvasSize(w, h) {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  // Returns false when the video cannot be read (CORS taint).
  function upload(name, video) {
    gl.bindTexture(gl.TEXTURE_2D, videoTex[name]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch (e) {
      return false;
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
    videoSize[name] = [video.videoWidth || 16, video.videoHeight || 9];
    return true;
  }

  function drawDeck(name, params, has, time, gen) {
    if (has && gen) has = drawGen(genFbo[name], name, gen);
    const fbo = deckFbo[name];
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!has) return;
    gl.useProgram(deckProg.p);
    const u = deckProg.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, gen ? genFbo[name].t : videoTex[name]); gl.uniform1i(u.tex, 0);
    if (gen) gl.uniform2f(u.texSize, W, H); else gl.uniform2f(u.texSize, videoSize[name][0], videoSize[name][1]);
    gl.uniform2f(u.outSize, W, H);
    gl.uniform1f(u.fitCover, params.fit === 'cover' ? 1 : 0);
    gl.uniform1f(u.zoom, params.zoom || 1);
    gl.uniform1f(u.rotate, (params.rotate || 0) * Math.PI / 180);
    gl.uniform1f(u.hue, (params.hue || 0) * Math.PI / 180);
    gl.uniform1f(u.saturate, params.saturate ?? 1);
    gl.uniform1f(u.contrast, params.contrast ?? 1);
    gl.uniform1f(u.brightness, params.brightness ?? 1);
    gl.uniform1f(u.invert, params.invert || 0);
    gl.uniform1f(u.pixelate, params.pixelate || 0);
    gl.uniform1f(u.rgbShift, params.rgbShift || 0);
    gl.uniform1f(u.posterize, params.posterize || 0);
    gl.uniform1f(u.threshold, params.threshold || 0);
    gl.uniform2f(u.crop, Math.min(0.45, params.cropX || 0), Math.min(0.45, params.cropY || 0));
    gl.uniform1f(u.blur, params.blur || 0);
    gl.uniform1i(u.mirror, params.mirror || 0);
    gl.uniform1i(u.kaleido, params.kaleido || 0);
    gl.uniform1f(u.halftone, params.halftone || 0);
    gl.uniform1f(u.dither, params.dither || 0);
    gl.uniform1f(u.ledWall, params.ledWall || 0);
    gl.uniform1f(u.ripple, params.ripple || 0);
    gl.uniform1f(u.spiral, params.spiral || 0);
    gl.uniform1f(u.glitch, params.glitch || 0);
    gl.uniform1i(u.palette, params.palette || 0);
    gl.uniform1i(u.edges, params.edges || 0);
    for (const k of ['ascii', 'riso', 'warp', 'stretchGrid', 'interference', 'grain', 'radialBlur', 'stretch', 'lumalines', 'scanMod', 'fisheye']) gl.uniform1f(u[k], params[k] || 0);
    gl.uniform1f(u.time, time % 3600);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // tube: the master, for the pane that shows the output through the CRT; deck panes pass none
  function blit(tex, pane, gain, premultiply, tube) {
    const [x, y, w, h] = pane;
    gl.uniform1f(outProg.u.crt, tube ? Math.min(1, Math.max(0, tube.crt || 0)) : 0);
    gl.uniform1f(outProg.u.crtCurve, tube ? Math.min(1, Math.max(0, tube.crtCurve || 0)) : 0);
    gl.uniform2f(outProg.u.paneSize, w, h);
    gl.viewport(x, canvas.height - y - h, w, h);
    gl.scissor(x, canvas.height - y - h, w, h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(outProg.u.tex, 0);
    gl.uniform1f(outProg.u.gain, gain);
    gl.uniform1f(outProg.u.premultiply, premultiply ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // The mixed picture as a worn tape plays it, into vhsFbo.
  function drawVhs(src, master, time) {
    const u = vhsProg.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, vhsFbo.fb);
    gl.viewport(0, 0, W, H);
    gl.useProgram(vhsProg.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src); gl.uniform1i(u.tex, 0);
    gl.uniform1f(u.vhs, Math.min(1, Math.max(0, master.vhs || 0)));
    gl.uniform1f(u.track, Math.min(1, Math.max(0, master.vhsTrack || 0)));
    gl.uniform1f(u.time, time % 3600);
    gl.uniform1ui(u.field, Math.floor(time * 59.94) >>> 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // The picture as the TV set shows it, into tvFbo.
  function drawTv(src, plan, master) {
    const r = plan.raster, u = tvProg.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, tvFbo.fb);
    gl.viewport(0, 0, W, H);
    gl.useProgram(tvProg.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src); gl.uniform1i(u.tex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rowsTex); gl.uniform1i(u.rows, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2, r.activeLines, 0, gl.RGBA, gl.FLOAT, plan.rows);
    gl.uniform1i(u.activeLines, r.activeLines); gl.uniform1i(u.vbiLines, r.vbiLines); gl.uniform1i(u.totalLines, r.totalLines);
    gl.uniform1i(u.preEqEnd, r.preEqEnd); gl.uniform1i(u.vsyncEnd, r.vsyncEnd); gl.uniform1i(u.postEqEnd, r.postEqEnd);
    gl.uniform1ui(u.ccBits, plan.ccBits); gl.uniform1ui(u.fieldIndex, plan.fieldIndex);
    const delay = Math.min(12, Math.max(0.2, master.tvDelay ?? 2));
    const angle = -2 * Math.PI * TIMING.SUBCARRIER_MHZ * delay;      // the delayed colour carrier arrives at another phase
    gl.uniform1f(u.ghostLevel, Math.min(1, Math.max(-1, master.tvGhost || 0)));
    gl.uniform1f(u.ghostDelay, delay);
    gl.uniform1f(u.ghostCos, Math.cos(angle)); gl.uniform1f(u.ghostSin, Math.sin(angle));
    gl.uniform1f(u.tvBright, Math.min(1, Math.max(0, master.tvBright || 0)));
    gl.uniform1f(u.pictureGain, plan.pictureGain);
    gl.uniform1f(u.noiseIRE, plan.noiseIre);
    gl.activeTexture(gl.TEXTURE0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // decks: { A: { params, active, gen? }, B }   (gen: a generator's frame, see drawGen)   master: { crossfade, feedback, fbZoom, fbRotate, fbHue, strobe, tv... }
  // panes: { out: [x, y, w, h], A?: [...], B?: [...] } in canvas pixels, y from the top
  function render(decks, master, time, panes) {
    if (!deckFbo) return;
    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    drawDeck('A', decks.A.params, decks.A.active, time, decks.A.gen);
    drawDeck('B', decks.B.params, decks.B.active, time, decks.B.gen);

    const [mA, mB] = crossfadeWeights(master.crossfade, decks.B.params.blend);
    const wA = (decks.A.params.opacity ?? 1) * mA;
    const wB = (decks.B.params.opacity ?? 1) * mB;
    const prev = ping[pingIndex], next = ping[1 - pingIndex];
    gl.bindFramebuffer(gl.FRAMEBUFFER, next.fb);
    gl.viewport(0, 0, W, H);
    gl.useProgram(mixProg.p);
    const u = mixProg.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, deckFbo.A.t); gl.uniform1i(u.texA, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, deckFbo.B.t); gl.uniform1i(u.texB, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, prev.t); gl.uniform1i(u.prev, 2);
    gl.uniform1f(u.wA, decks.A.active ? wA : 0);
    gl.uniform1f(u.wB, decks.B.active ? wB : 0);
    gl.uniform1i(u.blend, BLEND_INDEX[decks.B.params.blend] ?? 0);
    gl.uniform1f(u.feedback, master.feedback || 0);
    gl.uniform1f(u.fbZoom, master.fbZoom || 1);
    gl.uniform1f(u.fbRotate, (master.fbRotate || 0) * Math.PI / 180);
    gl.uniform1f(u.fbHue, (master.fbHue || 0) * Math.PI / 180);
    gl.uniform1f(u.fbKey, Math.min(1, Math.max(0, master.fbKey || 0)));
    gl.uniform1f(u.fbTilt, Math.min(0.5, Math.max(-0.5, master.fbTilt || 0)));
    gl.uniform1f(u.fbBlur, Math.min(1, Math.max(0, master.fbBlur || 0)));
    gl.uniform2f(u.fbCentre, Math.min(0.5, Math.max(-0.5, master.fbX || 0)), Math.min(0.5, Math.max(-0.5, master.fbY || 0)));
    gl.uniform2f(u.outSize, W, H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    pingIndex = 1 - pingIndex;

    // Tape, then the set that plays it, both after the feedback loop so their faults
    // do not trail. Each pass is skipped while its sliders are at rest (the TV: while
    // every knob is healthy and the picture has settled, so there is no plan).
    let shown = next.t;
    if ((master.vhs || 0) > 0 || (master.vhsTrack || 0) > 0) { drawVhs(shown, master, time); shown = vhsFbo.t; }
    const plan = tv.update(master, time);
    if (plan) { drawTv(shown, plan, master); shown = tvFbo.t; }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.useProgram(outProg.p);
    const strobe = master.strobe || 0;
    const gain = strobe > 0 ? ((time * strobe) % 1 < 0.5 ? 1 : 0) : 1;
    if (panes.out) blit(shown, panes.out, gain, false, master);
    if (panes.A) blit(deckFbo.A.t, panes.A, 1, true);
    if (panes.B) blit(deckFbo.B.t, panes.B, 1, true);
    gl.disable(gl.SCISSOR_TEST);
  }

  function clear() {
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (ping) for (const t of ping) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb); gl.clear(gl.COLOR_BUFFER_BIT); }
  }

  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    gl, resize, setCanvasSize, upload, render, clear, genThumb,
    info: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'webgl2',
  };
}
