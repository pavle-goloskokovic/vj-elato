// Web MIDI: a controller surface drives the decks through a device file (midi/*.json).
//
// The device file lists physical controls (id -> message) and roles (id -> what it does).
// Absolute knobs and faders use soft takeover: after a reload or when the shift layer
// changes, a knob only takes over once it passes through the value on screen, so nothing
// jumps. Buttons can be toggles, momentary (hold to apply, release to restore), steps,
// commands or a per-deck shift. Endless encoders and jog wheels send relative ticks.
// Button LEDs are driven back over the output port from the state they represent.

export function createMidi(api) {
  const state = {
    access: null, inputs: [], output: null, device: null, byMsg: new Map(), shift: { A: false, B: false },
    takeover: new Map(),     // control id -> { engaged, last }
    held: new Map(),         // control id -> previous value to restore on release
    leds: new Map(),         // note -> last sent on/off
    status: 'off', error: null,
  };
  const listeners = new Set();
  const emit = () => { for (const f of listeners) f(state); };

  async function connect() {
    if (!navigator.requestMIDIAccess) { state.status = 'unsupported'; emit(); return false; }
    try {
      state.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) { state.status = 'denied'; state.error = e.message; emit(); return false; }
    state.access.onstatechange = () => attach();
    attach();
    return true;
  }

  function attach() {
    const ins = [...state.access.inputs.values()], outs = [...state.access.outputs.values()];
    const dev = (api.devices || []).find((d) => ins.some((p) => d.match.some((m) => (p.name || '').toLowerCase().includes(m.toLowerCase()))));
    for (const p of state.inputs) p.onmidimessage = null;
    state.inputs = []; state.output = null; state.device = dev || null; state.byMsg.clear();
    if (!dev) { state.status = ins.length ? 'unknown' : 'none'; state.deviceNames = ins.map((p) => p.name); emit(); return; }
    for (const p of ins) if (dev.match.some((m) => (p.name || '').toLowerCase().includes(m.toLowerCase()))) { p.onmidimessage = (e) => handle(e.data); state.inputs.push(p); }
    state.output = outs.find((p) => dev.match.some((m) => (p.name || '').toLowerCase().includes(m.toLowerCase()))) || null;
    for (const [id, c] of Object.entries(dev.controls)) state.byMsg.set(`${c.msg}:${c.ch || 1}:${c.num}`, id);
    state.status = 'connected'; state.name = state.inputs[0].name;
    emit(); refreshLeds();
  }

  // ---------- incoming ----------
  function handle(data) {
    const [s, d1, d2] = data; const type = s >> 4, ch = (s & 0xF) + 1;
    state.lastInput = Date.now();
    if (state.show) { state.show = false; if (api.onIdleEnd) api.onIdleEnd(); }       // any touch ends the idle show
    let msg, val, pressed = null;
    if (type === 0x9 || type === 0x8) { msg = 'note'; val = type === 0x9 ? d2 : 0; pressed = val > 0; }
    else if (type === 0xB) { msg = 'cc'; val = d2; }
    else return;
    const id = state.byMsg.get(`${msg}:${ch}:${d1}`);
    if (!id) return;
    const ctl = state.device.controls[id];
    let role = state.device.roles[id];
    if (!role || role.do === 'none' || ctl.type === 'led') return;
    const deck = role.deck || (role.shift && role.shift.deck);
    if (role.shift && deck && state.shift[deck]) role = role.shift;
    if (ctl.type === 'button') onButton(id, role, pressed);
    else if (ctl.type === 'encoder' || ctl.type === 'jog') onRelative(id, role, val);
    else onAbsolute(id, role, val);
  }

  const ticks = (v) => (v <= 63 ? v : v - 128);          // 1..3 clockwise, 127..125 counter-clockwise

  function onRelative(id, role, val) {
    const t = ticks(val); if (!t) return;
    if (role.do === 'relative') {
      const r = api.paramRange(role.deck, role.param);
      const cur = api.getParam(role.deck, role.param);
      if (r.steps) { const i = Math.max(0, Math.min(r.steps.length - 1, r.steps.indexOf(cur) + Math.sign(t))); api.setParam(role.deck, role.param, r.steps[i]); return; }
      api.setParam(role.deck, role.param, clamp(cur + t * (role.step || r.step || 1), r.min, r.max));
    } else if (role.do === 'seek') api.seek(role.deck, t * (role.step || 0.5));
    else if (role.do === 'browse') api.browse(Math.sign(t));
    else if (role.do === 'master') { const r = api.masterRange(role.param); api.setMaster(role.param, clamp(api.getMaster(role.param) + t * (role.step || r.step || 0.01), r.min, r.max)); }
  }

  function onAbsolute(id, role, val) {
    const norm = role.invert ? 1 - val / 127 : val / 127;
    let target, cur, r, set;
    if (role.do === 'master') { r = api.masterRange(role.param); cur = api.getMaster(role.param); set = (v) => api.setMaster(role.param, v); }
    else if (role.do === 'param') { r = api.paramRange(role.deck, role.param); cur = api.getParam(role.deck, role.param); set = (v) => api.setParam(role.deck, role.param, v); }
    else return;
    if (role.curve === 'pitch') target = Math.pow(2, (norm - 0.5) * 2);           // centre = 1x, ends = 0.5x and 2x
    else target = r.min + norm * (r.max - r.min);
    if (r.step) target = Math.round(target / r.step) * r.step;
    // soft takeover, keyed by control and layer
    const key = id + (state.shift[role.deck] ? ':shift' : '');
    const to = state.takeover.get(key) || { engaged: false, last: null };
    const span = r.max - r.min || 1;
    const near = Math.abs(target - cur) <= Math.max(span * 0.03, r.step || 0);
    const crossed = to.last != null && ((to.last - cur) * (target - cur) <= 0);
    if (!to.engaged && !(near || crossed)) { to.last = target; state.takeover.set(key, to); api.pickup && api.pickup(role, target, cur); return; }
    to.engaged = true; to.last = target; state.takeover.set(key, to);
    set(target);
  }

  function onButton(id, role, pressed) {
    const d = role.deck;
    switch (role.do) {
      case 'shift': state.shift[d] = pressed; disengage(d); led(id, pressed); break;
      case 'cmd': if (pressed) api.command(role.cmd, d); break;
      case 'toggle': if (pressed) {
        const cur = role.param === 'fit' ? api.getParam(d, 'fit') : api.getParam(d, role.param);
        const on = 'on' in role ? role.on : true, off = 'off' in role ? role.off : false;
        api.setParam(d, role.param, cur === on ? off : on);
      } break;
      case 'momentary': if (pressed) { state.held.set(id, api.getParam(d, role.param)); api.setParam(d, role.param, role.value); }
        else if (state.held.has(id)) { api.setParam(d, role.param, state.held.get(id)); state.held.delete(id); }
        led(id, pressed); break;
      case 'master-momentary': if (pressed) { state.held.set(id, api.getMaster(role.param)); api.setMaster(role.param, role.value); }
        else if (state.held.has(id)) { api.setMaster(role.param, state.held.get(id)); state.held.delete(id); }
        led(id, pressed); break;
      case 'step': if (pressed) { const r = api.paramRange(d, role.param); const steps = r.steps || null; const cur = api.getParam(d, role.param);
        if (steps) { const i = Math.max(0, Math.min(steps.length - 1, steps.indexOf(cur) + role.dir)); api.setParam(d, role.param, steps[i]); }
        else api.setParam(d, role.param, clamp(cur + role.dir * (r.step || 1), r.min, r.max)); } break;
      case 'set': if (pressed) for (const [k, v] of Object.entries(role.params)) api.setParam(d, k, v); led(id, pressed); break;
      case 'reset': if (pressed) api.reset(d); break;
      case 'load': if (pressed) api.loadSelected(role.deck === 'target' ? null : role.deck); break;
      case 'browse': break;
      case 'nexttab': if (pressed) api.nextTab(); break;
    }
    if (pressed !== null) refreshLeds();
  }
  // when the shift layer changes, every absolute control has to pick up again
  function disengage(deck) { for (const [k, v] of state.takeover) if (k.startsWith(deck + '.') || !k.includes('.')) v.engaged = false; }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---------- LEDs ----------
  function led(id, on) {
    const c = state.device && state.device.controls[id];
    if (!c || c.msg !== 'note') return;
    const want = on ? (state.device.led?.on ?? 127) : (state.device.led?.off ?? 0);
    if (state.leds.get(c.num) === want) return;
    state.leds.set(c.num, want);
    if (state.ledLog) { state.ledLog.push([id, on]); if (state.ledLog.length > 500) state.ledLog.splice(0, 250); }
    if (!state.output) return;
    try { state.output.send([0x90 | ((c.ch || 1) - 1), c.num, want]); } catch { /* port gone */ }
  }
  // the idle light show writes the lights directly; state LEDs resume when it ends
  function setLeds(map) { for (const [id, on] of Object.entries(map)) led(id, on); }
  function refreshLeds() {
    if (!state.device || state.show) return;
    for (const [id, role] of Object.entries(state.device.roles)) {
      if (!role.led) continue;
      const d = role.deck;
      let on = false;
      if (role.led === 'playing') on = api.isPlaying(d);
      else if (role.led === 'hasclip') on = api.hasClip(role.deck);
      else if (role.led === 'param') { const cur = api.getParam(d, role.param); on = 'on' in role ? cur === role.on : !!cur; }
      else if (role.led === 'shift') on = !!state.shift[d];
      else if (role.led === 'held') on = state.held.has(id);
      else if (role.led === 'speed') on = Math.abs((api.getParam(d, 'speed') || 1) - 1) > 0.02;      // the pitch LED: deck off normal speed
      else if (role.led === 'target') on = api.targetDeck() === role.deck;                            // FOLDER = A, FILE = B
      led(id, on);
    }
  }
  function allLeds(on) { if (!state.device) return; for (const [id, c] of Object.entries(state.device.controls)) if (c.msg === 'note') { state.leds.delete(c.num); led(id, on); } }

  // a device without ports, for tests and for trying a map without the hardware
  function useDevice(dev) {
    state.device = dev; state.byMsg.clear(); state.output = null; state.inputs = [];
    for (const [id, c] of Object.entries(dev.controls)) state.byMsg.set(`${c.msg}:${c.ch || 1}:${c.num}`, id);
    state.status = 'virtual'; state.name = dev.device + ' (virtual)'; emit();
  }

  state.lastInput = Date.now(); state.show = false; state.ledLog = null;
  return {
    connect, state, refreshLeds, allLeds, handle, useDevice, setLeds,
    onChange: (f) => listeners.add(f),
    // the LED self-test: light every button in turn so the user sees which ones the device drives
    async sweep(ms = 120) {
      if (!state.device || !state.output) return 0;
      const ids = Object.entries(state.device.controls).filter(([, c]) => c.msg === 'note').map(([id]) => id);
      allLeds(false);
      for (const id of ids) { led(id, true); await new Promise((r) => setTimeout(r, ms)); led(id, false); }
      refreshLeds();
      return ids.length;
    },
  };
}
