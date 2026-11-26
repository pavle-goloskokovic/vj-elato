// Generators: pictures made by a shader instead of read from a video. A deck loaded with one
// behaves like a deck with a clip: the generator is drawn into the deck's source texture, so
// every deck look, the crossfader and the master chain apply to it unchanged.
//
// Each generator is the body of `vec3 gen(vec2 uv, vec2 p)`:
//   uv  0..1 over the picture, y up
//   p   centred, y from -1 to 1, x scaled by the aspect ratio
// with the uniforms time (seconds, runs at the deck's speed, stops on pause), a, b, c (the deck's
// three generator sliders, 0..1, 0.5 in the middle), size (pixels) and, for the two that draw a
// picture, img / imgSize / hasImg. `params` names the three sliders; `uses` says which picture
// the stage hands over: 'overlay' the master's overlay image, 'text' the deck's own text.

export const GEN_DEFAULTS = { genA: 0.5, genB: 0.5, genC: 0.5, genText: 'VJ ELATO' };

const HEAD = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform float time, a, b, c;
uniform vec2 size;
uniform sampler2D img;
uniform vec2 imgSize;
uniform float hasImg;
const float PI = 3.14159265;
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, w = 0.5;
  for (int i = 0; i < 4; i++) { v += w * noise(p); p = p * 2.03 + 17.1; w *= 0.5; }
  return v;
}
vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(fract(h + vec3(0.0, 2.0, 1.0) / 3.0) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
float tri(float t) { float f = fract(t); return f < 0.5 ? f * 4.0 - 1.0 : 3.0 - f * 4.0; }   // -1..1..-1
`;
const TAIL = `
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * vec2(size.x / size.y, 1.0);
  o = vec4(clamp(gen(vUv, p), 0.0, 1.0), 1.0);
}`;

export const GENERATORS = [
  {
    id: 'plasma', title: 'Plasma', sub: 'rolling colour waves', params: ['scale', 'warp', 'colour'],
    body: `vec3 gen(vec2 uv, vec2 p) {
  vec2 q = p * mix(1.5, 9.0, a);
  float t = time * 0.6;
  q += b * 2.0 * vec2(sin(q.y * 0.7 + t), cos(q.x * 0.6 - t * 0.8));
  float v = sin(q.x + t) + sin(q.y * 1.3 - t * 1.2) + sin((q.x + q.y) * 0.7 + t * 0.7)
          + sin(length(q - 2.0 * vec2(sin(t * 0.5), cos(t * 0.4))) * 1.5 - t);
  v *= 0.25;
  return hsv(fract(v * 0.6 + c + time * 0.02), 0.85, 0.55 + 0.45 * sin(v * PI * 2.0));
}`,
  },
  {
    id: 'tunnel', title: 'Tunnel', sub: 'chequered tube flying past', params: ['segments', 'twist', 'colour'],
    body: `vec3 gen(vec2 uv, vec2 p) {
  float r = length(p) + 1e-3, ang = atan(p.y, p.x);
  float z = 0.5 / r + time * 0.8;
  float n = 2.0 * floor(mix(2.0, 9.0, a));                 // even, so the seam at the left keeps the chequer
  float u = (ang / (2.0 * PI) + 0.5) * n + (b - 0.5) * 6.0 * z;
  float chk = mod(floor(u) + floor(z * 4.0), 2.0);
  return hsv(fract(c + z * 0.03), 0.7, mix(0.12, 1.0, chk)) * smoothstep(0.02, 0.6, r);
}`,
  },
  {
    id: 'starfield', title: 'Starfield', sub: 'stars rushing out of the middle', params: ['density', 'streaks', 'colour'],
    body: `vec3 gen(vec2 uv, vec2 p) {
  vec3 col = vec3(0.0);
  vec2 dir = normalize(p + 1e-4);
  for (float i = 0.0; i < 6.0; i++) {
    float z = fract(i / 6.0 + time * 0.12);
    vec2 q = p * mix(18.0, 0.6, z) * mix(0.6, 2.0, a) + i * 37.3;
    vec2 id = floor(q), f = fract(q) - 0.5;
    float h = hash(id);
    vec2 v = f - (vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5) * 0.6;
    float d = length(vec2(dot(v, dir) / (1.0 + b * 8.0 * z), dot(v, vec2(-dir.y, dir.x))));
    float star = smoothstep(0.07, 0.0, d) * step(0.55, h);
    col += star * smoothstep(0.0, 0.15, z) * smoothstep(1.0, 0.8, z) * mix(vec3(1.0), hsv(fract(h * 7.0), 0.7, 1.0), c);
  }
  return col;
}`,
  },
  {
    id: 'grid', title: 'Grid', sub: 'floor and ceiling of lines moving towards you', params: ['density', 'horizon', 'colour'],
    body: `vec3 gen(vec2 uv, vec2 p) {
  float y = p.y - mix(-0.6, 0.6, b);
  float d = abs(y) + 1e-3;
  vec2 g = vec2(p.x / d, 1.0 / d + time * 1.5) * mix(0.5, 3.0, a);
  vec2 f = abs(fract(g) - 0.5);
  vec2 l = 1.0 - smoothstep(vec2(0.0), fwidth(g) * 1.5 + 0.02, f);
  float line = max(l.x, l.y) * min(1.0, d * 2.5);
  return hsv(c, 0.8, 1.0) * line + hsv(fract(c + 0.12), 0.9, 1.0) * 0.45 * exp(-d * 7.0);
}`,
  },
  {
    id: 'bars', title: 'Colour bars', sub: 'test card with a grey ramp and a sweep', params: ['drift', 'steps', 'colour'],
    body: `vec3 bar(float i) {          // white, yellow, cyan, green, magenta, red, blue
  float v = 7.0 - mod(i, 7.0);
  return 0.75 * vec3(step(2.0, mod(v, 4.0)), step(4.0, v), mod(v, 2.0));
}
vec3 gen(vec2 uv, vec2 p) {
  float i = floor(fract(uv.x + (a - 0.5) * time * 0.5) * 7.0);
  vec3 col;
  if (uv.y > 0.33) col = bar(i);
  else if (uv.y > 0.25) col = bar(6.0 - i);
  else if (uv.y > 0.1) { float n = floor(mix(2.0, 32.0, b)); col = vec3(floor(uv.x * n) / (n - 1.0)); }
  else col = vec3(step(abs(fract(uv.x - time * 0.25) - 0.5), 0.02));
  return mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, c * 2.0);
}`,
  },
  {
    id: 'nebula', title: 'Nebula', sub: 'drifting clouds of gas with stars', params: ['scale', 'swirl', 'colour'],
    body: `vec3 gen(vec2 uv, vec2 p) {
  vec2 q = p * mix(0.8, 3.5, a);
  float t = time * 0.05;
  vec2 w = vec2(fbm(q + t), fbm(q + vec2(5.2, 1.3) - t));
  float n = fbm(q + (0.5 + b * 3.0) * w + t);
  vec3 col = hsv(fract(c + 0.15 * w.x + n * 0.3), 0.75, 1.0) * pow(n, 2.2) * 2.2;
  col += hsv(fract(c + 0.5), 0.5, 1.0) * pow(w.y, 4.0) * 0.8;
  col += step(0.997, hash(floor(uv * size / 3.0))) * (1.0 - n);
  return col;
}`,
  },
  {
    id: 'fractalgrid', title: 'Fractal grid', sub: 'squares that split into squares and flicker', params: ['depth', 'density', 'colour'],
    body: `vec3 gen(vec2 uv, vec2 p) {
  vec2 q = uv * vec2(size.x / size.y, 1.0) * mix(2.0, 6.0, b);
  vec2 id = floor(q), f = fract(q);
  float depth = floor(mix(1.0, 5.0, a) + 0.5);
  for (float i = 0.0; i < 5.0; i++) {
    if (i >= depth) break;
    if (hash(id + i * 17.0 + floor(time * 0.3 + hash(id + 1.7) * 4.0)) < 0.45) break;
    f *= 2.0; vec2 s = floor(f); f -= s; id = id * 2.0 + s + 13.0;
  }
  float h = hash(id + 3.0);
  float on = step(0.5, hash(id + floor(time * 0.7 + h * 5.0)));
  float edge = min(min(f.x, f.y), min(1.0 - f.x, 1.0 - f.y));
  return hsv(fract(c + h * 0.25), 0.7, mix(0.1, 1.0, on * (0.4 + 0.6 * h))) * smoothstep(0.0, 0.05, edge);
}`,
  },
  {
    id: 'moire', title: 'Interference', sub: 'two sets of rings crossing into moiré', params: ['pitch', 'spread', 'colour'],
    body: `vec3 gen(vec2 uv, vec2 p) {
  float k = mix(15.0, 90.0, a), t = time * 0.3, sp = mix(0.1, 1.0, b);
  vec2 c1 = sp * vec2(cos(t), sin(t * 1.3)), c2 = sp * vec2(cos(t * 0.7 + 2.0), sin(t * 0.9 + 1.0));
  float v = sin(length(p - c1) * k) + sin(length(p - c2) * k);
  return mix(vec3(0.02), hsv(fract(c + 0.08 * v), 0.65, 1.0), smoothstep(-0.3, 0.3, v));
}`,
  },
  {
    // After a hotel carpet: strips of square tiles, each tile four triangles in greys, some tiles
    // twice the size, on a speckled blue-grey ground that shows between the strips and through
    // holes in them, with black lines down some of the strip edges.
    id: 'rug', title: 'Rug', sub: 'strips of triangle tiles on a speckled ground, sliding and reshuffling', params: ['scale', 'shuffle', 'colour'],
    body: `// both coordinates vary with the column: with one held constant this hash clumps for small whole numbers
bool gapRaw(float i) { return hash(vec2(i + 0.37, i * 0.61 + 7.31)) < 0.3; }
bool gapCol(float i) { return gapRaw(i) && !gapRaw(i - 1.0); }           // ground strips are one column wide, never two side by side
vec3 gen(vec2 uv, vec2 p) {
  vec2 q = p * mix(3.0, 11.0, a);                    // one unit is a small tile
  q.y += time * 0.3;
  // the ground: blotches of two blue-greys, a few light flecks
  vec2 g = q * 11.0;
  float n = noise(g) * 0.65 + noise(g * 2.7 + 9.0) * 0.35;
  vec3 col = mix(hsv(fract(0.57 + c - 0.5), 0.2, 0.56), hsv(fract(0.56 + c - 0.5), 0.09, 0.8), smoothstep(0.46, 0.54, n));
  col = mix(col, hsv(fract(0.58 + c - 0.5), 0.26, 0.42), smoothstep(0.3, 0.26, n));
  float i = floor(q.x);
  vec2 blk = floor(q / 2.0);
  bool hole = hash(vec2(blk.x, floor(blk.y / 2.0)) + 3.3) < 0.1;      // a patch of ground inside a strip, 2 by 4 tiles
  bool wide = !gapCol(blk.x * 2.0) && !gapCol(blk.x * 2.0 + 1.0);
  if (!hole && !gapCol(i)) {
    bool big = wide && hash(blk + 11.0) < 0.3;                         // a tile of twice the size
    vec2 id = big ? blk * 2.0 + 0.5 : floor(q), f = big ? fract(q / 2.0) : fract(q);
    float tri_ = f.y > f.x ? (f.y > 1.0 - f.x ? 0.0 : 1.0) : (f.y > 1.0 - f.x ? 2.0 : 3.0);
    float tick = floor(time * b * b * 2.0 + hash(id + 1.9) * 8.0);     // each tile redraws its shades at its own moment
    float h = hash(id * 1.3 + vec2(tri_ * 17.0 + 0.7, tick * 3.7));
    col = h < 0.07 ? (big ? vec3(0.4, 0.38, 0.37) : vec3(0.07))
        : h < 0.32 ? vec3(0.95, 0.94, 0.92)
        : h < 0.56 ? vec3(0.78, 0.77, 0.76)
        : h < 0.8 ? vec3(0.6, 0.59, 0.58) : vec3(0.52, 0.47, 0.44);
  }
  // a black line down some of the joints between columns, ground or tiles alike
  float j = floor(q.x + 0.5);
  if (hash(vec2(j + 0.81, j * 0.43 + 23.17)) < 0.3 &&!(gapCol(j) && gapCol(j - 1.0))) col = mix(col, vec3(0.05), smoothstep(0.07, 0.04, abs(q.x - j)));
  return col;
}`,
  },
  {
    id: 'logo', title: 'Bouncing logo', sub: 'the overlay image (or a ring) bouncing off the edges, a new colour at every hit', params: ['size', 'tint', 'colour'], uses: 'overlay',
    body: `vec3 gen(vec2 uv, vec2 p) {
  float s = mix(0.08, 0.5, a);
  vec2 half_ = vec2(s * (hasImg > 0.5 ? imgSize.x / imgSize.y : 1.0), s);
  vec2 range = max(vec2(size.x / size.y, 1.0) - half_, vec2(1e-3));
  vec2 ph = time * vec2(0.45, 0.37) / (4.0 * range) + vec2(0.1, 0.35);
  vec2 q = (p - range * vec2(tri(ph.x), tri(ph.y))) / half_;        // -1..1 over the logo
  float hits = floor(ph.x * 2.0) + floor(ph.y * 2.0);
  vec3 tint = mix(vec3(1.0), hsv(fract(c + hits * 0.381966), 0.9, 1.0), b);
  if (abs(q.x) > 1.0 || abs(q.y) > 1.0) return vec3(0.0);
  if (hasImg > 0.5) { vec4 t = texture(img, q * 0.5 + 0.5); return t.rgb * t.a * tint; }
  float e = length(q);
  return tint * (smoothstep(1.0, 0.96, e) * smoothstep(0.7, 0.74, e) + smoothstep(0.34, 0.3, e));
}`,
  },
  {
    id: 'text', title: 'Text', sub: 'your words in scrolling rows', params: ['size', 'wave', 'colour'], uses: 'text',
    body: `vec3 gen(vec2 uv, vec2 p) {
  if (hasImg < 0.5) return vec3(0.0);
  float rows = floor(mix(8.0, 1.0, a) + 0.5);
  float y = (uv.y + b * 0.06 * sin(uv.x * 7.0 + time * 2.0)) * rows;
  float row = floor(y);
  float tile = imgSize.x / imgSize.y / rows * size.y / size.x;      // width of one copy of the text, in uv
  float x = uv.x / tile + (mod(row, 2.0) < 0.5 ? 1.0 : -1.0) * time * 0.25 + row * 0.37;
  return hsv(fract(c + row * 0.07), 0.75, 1.0) * texture(img, vec2(fract(x), fract(y))).a;
}`,
  },
];

export const GEN_BY_ID = Object.fromEntries(GENERATORS.map((g) => [g.id, g]));
export const genShader = (g) => HEAD + g.body + TAIL;

// The text of a text generator as a picture: white on clear, one line. Returns the canvas, or
// null for empty text.
export function drawText(canvas, text) {
  text = String(text ?? '').trim().slice(0, 80);
  if (!text) return null;
  const font = '900 100px "Arial Black", Impact, "Helvetica Neue", Arial, sans-serif';
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 80, k = Math.min(1, 4096 / w);
  canvas.width = Math.max(2, Math.round(w * k)); canvas.height = Math.round(128 * k);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, w, 128);
  ctx.font = font; ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 40, 68);
  return canvas;
}
