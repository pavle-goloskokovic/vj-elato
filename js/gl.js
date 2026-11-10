// WebGL2 compositor shared by the player and the controller previews.
//
// Each deck's video is sampled as a texture and run through a per-deck effect
// shader into its own framebuffer. The two decks are then mixed (crossfade +
// blend mode) with a feedback trail from the previous frame into a ping-pong
// framebuffer, and finally blitted to one or more panes of the canvas with
// strobe applied. The player uses one full-window pane; the controller shows
// deck A, the output and deck B side by side at a small size.
//
// Only decks whose video can be read by WebGL are drawn here: local files
// (blob: URLs) and same-origin files. Neither Destockd's CDN nor archive.org's
// storage nodes send CORS headers on video, so streams taint WebGL and the
// stage keeps such a deck as a plain <video> layer with CSS filters instead.

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
uniform int mirror, kaleido;

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

  vec2 d = (uv - 0.5) * vec2(ca, 1.0);
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
  if (rgbShift > 0.0) {
    vec2 sh = vec2(rgbShift * 0.04, 0.0);
    c.r = sampleTex(t + sh).r;
    c.b = sampleTex(t - sh).b;
  }
  if (c.a <= 0.0) { o = vec4(0.0); return; }

  vec3 col = c.rgb * brightness;
  col = (col - 0.5) * contrast + 0.5;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, saturate);
  if (hue != 0.0) col = hueRotate(col, hue);
  if (posterize >= 2.0) col = floor(col * posterize + 0.5) / posterize;
  if (threshold > 0.0) col = vec3(step(threshold, dot(col, vec3(0.299, 0.587, 0.114))));
  col = mix(col, 1.0 - col, invert);
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const MIX_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D texA, texB, prev;
uniform float wA, wB, feedback, fbZoom, fbRotate, fbHue;
uniform int blend;
uniform vec2 outSize;

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
    vec2 d = (vUv - 0.5) * vec2(ca, 1.0);
    float s = sin(fbRotate), c = cos(fbRotate);
    d = mat2(c, -s, s, c) * d / fbZoom;
    vec2 fuv = d / vec2(ca, 1.0) + 0.5;
    vec4 p = (fuv.x < 0.0 || fuv.x > 1.0 || fuv.y < 0.0 || fuv.y > 1.0) ? vec4(0.0) : texture(prev, fuv);
    p *= feedback;
    if (fbHue != 0.0 && p.a > 0.0) p.rgb = clamp(hueRotate(p.rgb / p.a, fbHue), 0.0, 1.0) * p.a;
    col = max(col, p.rgb); al = max(al, p.a);
  }
  o = vec4(col, al);
}`;

const OUT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D tex;
uniform float gain, premultiply;
void main() {
  vec4 c = texture(tex, vUv);
  if (premultiply > 0.5) c.rgb *= c.a;
  o = c * gain;
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
  const deckProg = program(DECK_FRAG), mixProg = program(MIX_FRAG), outProg = program(OUT_FRAG);
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

  let W = 0, H = 0, deckFbo = null, ping = null, pingIndex = 0;
  // Internal render size (the framebuffers). The canvas itself may be larger
  // or smaller; panes are scaled on blit.
  function resize(w, h) {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (w === W && h === H) return;
    W = w; H = h;
    deckFbo = { A: target(w, h), B: target(w, h) };
    ping = [target(w, h), target(w, h)];
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

  function drawDeck(name, params, has) {
    const fbo = deckFbo[name];
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!has) return;
    gl.useProgram(deckProg.p);
    const u = deckProg.u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, videoTex[name]); gl.uniform1i(u.tex, 0);
    gl.uniform2f(u.texSize, videoSize[name][0], videoSize[name][1]);
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
    gl.uniform1i(u.mirror, params.mirror || 0);
    gl.uniform1i(u.kaleido, params.kaleido || 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function blit(tex, pane, gain, premultiply) {
    const [x, y, w, h] = pane;
    gl.viewport(x, canvas.height - y - h, w, h);
    gl.scissor(x, canvas.height - y - h, w, h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(outProg.u.tex, 0);
    gl.uniform1f(outProg.u.gain, gain);
    gl.uniform1f(outProg.u.premultiply, premultiply ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // decks: { A: { params, active }, B }   master: { crossfade, feedback, fbZoom, fbRotate, fbHue, strobe }
  // panes: { out: [x, y, w, h], A?: [...], B?: [...] } in canvas pixels, y from the top
  function render(decks, master, time, panes) {
    if (!deckFbo) return;
    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    drawDeck('A', decks.A.params, decks.A.active);
    drawDeck('B', decks.B.params, decks.B.active);

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
    gl.uniform2f(u.outSize, W, H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    pingIndex = 1 - pingIndex;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.useProgram(outProg.p);
    const strobe = master.strobe || 0;
    const gain = strobe > 0 ? ((time * strobe) % 1 < 0.5 ? 1 : 0) : 1;
    if (panes.out) blit(next.t, panes.out, gain, false);
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
    gl, resize, setCanvasSize, upload, render, clear,
    info: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'webgl2',
  };
}
