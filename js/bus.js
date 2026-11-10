// Tab-to-tab messaging over BroadcastChannel. Both pages must share an origin
// (GitHub Pages, or one local static server). Messages are plain objects with a
// `type`; File objects travel as references, not copies.

export const CHANNEL = 'vj-elato';

export function createBus(role) {
  const bc = new BroadcastChannel(CHANNEL);
  const handlers = new Map();

  bc.onmessage = (e) => {
    const m = e.data;
    if (!m || typeof m.type !== 'string' || m.from === role) return;
    const h = handlers.get(m.type);
    if (h) h(m);
    const any = handlers.get('*');
    if (any) any(m);
  };

  return {
    send(type, payload = {}) {
      bc.postMessage({ ...payload, type, from: role, sent: Date.now() });
    },
    on(type, fn) { handlers.set(type, fn); return this; },
    close() { bc.close(); },
  };
}

// Message types, controller -> player
//   load   { deck, source: {kind:'file', file} | {kind:'url', url}, meta: {title, in?, out?} }
//   play / pause / restart  { deck }
//   seek   { deck, time }
//   deck   { deck, params: { opacity, speed, loop, hue, saturate, contrast, brightness, invert, blur, blend } }
//   master { params: { crossfade, blackout } }
//   sync   { decks: {A: {source, meta, params, playing}, B: ...}, master }
//   ping   {}
// player -> controller
//   hello  {}                                   on load, asks for a sync
//   status { decks: {A: {time, duration, paused, ready, error, title}}, fullscreen }
