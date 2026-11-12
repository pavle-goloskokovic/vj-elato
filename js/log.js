// Session log: what went wrong and what happened, so a bad set can be debugged afterwards.
//
// Every page keeps a ring buffer of recent events (persisted in localStorage, capped) and,
// when served by the local server, posts them in batches to /log, which writes one JSON
// line per event to the session file on the laptop and on the stick. Status chatter is
// never logged, only events: loads, failures, stalls, stick and server state, errors.
// Identical consecutive events are folded with a count, and a flood is capped per second.

const MAX_BUFFER = 400, MAX_PER_SECOND = 20, FLUSH_MS = 2000;
const KEY = 'vj-elato-log';

const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
let buffer = [], pending = [], flushTimer = null, lastEvent = null, secondStart = 0, inSecond = 0, dropped = 0;
try { buffer = JSON.parse(localStorage.getItem(KEY) || '[]').slice(-MAX_BUFFER); } catch { buffer = []; }

export function createLog(source) {
  function log(level, type, message, details) {
    const now = Date.now();
    if (now - secondStart > 1000) { if (dropped) pushRaw({ ts: now, src: source, level: 'warn', type: 'log.dropped', message: `${dropped} events dropped (flood)` }); secondStart = now; inSecond = 0; dropped = 0; }
    if (++inSecond > MAX_PER_SECOND) { dropped++; return; }
    if (lastEvent && lastEvent.type === type && lastEvent.message === message && now - lastEvent.ts < 5000) { lastEvent.count = (lastEvent.count || 1) + 1; lastEvent.ts = now; return; }
    const e = { ts: now, src: source, level, type, message };
    if (details !== undefined) e.details = details;
    pushRaw(e); lastEvent = e;
  }
  function pushRaw(e) {
    buffer.push(e); if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
    pending.push(e);
    try { localStorage.setItem(KEY, JSON.stringify(buffer)); } catch { /* storage full or blocked */ }
    if (local && !flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }
  async function flush() {
    flushTimer = null;
    if (!local || !pending.length) return;
    const batch = pending; pending = [];
    try { await fetch(new URL('log', location.href), { method: 'POST', body: JSON.stringify({ events: batch }), keepalive: true }); }
    catch { pending = batch.concat(pending).slice(-MAX_BUFFER); }
  }
  // uncaught errors from this page
  window.addEventListener('error', (ev) => log('error', 'js.error', String(ev.message || ev.error || 'error'), { file: ev.filename, line: ev.lineno }));
  window.addEventListener('unhandledrejection', (ev) => log('error', 'js.rejection', String(ev.reason && (ev.reason.message || ev.reason)).slice(0, 300)));
  window.addEventListener('pagehide', () => { if (local && pending.length) { try { navigator.sendBeacon(new URL('log', location.href), JSON.stringify({ events: pending })); pending = []; } catch { /* ignore */ } } });

  log('info', 'page.open', `${source} opened`, { ua: navigator.userAgent, screen: `${screen.width}x${screen.height}`, local });
  return {
    info: (type, message, details) => log('info', type, message, details),
    warn: (type, message, details) => log('warn', type, message, details),
    error: (type, message, details) => log('error', type, message, details),
    entries: () => buffer.slice(),
    flush,
    // one text file of this page's buffer (used on the web version, where there is no server)
    asText: () => buffer.map((e) => `${new Date(e.ts).toISOString()} ${e.level.padEnd(5)} ${e.src.padEnd(10)} ${e.type.padEnd(18)} ${e.message}${e.count > 1 ? ` (x${e.count})` : ''}${e.details ? '  ' + JSON.stringify(e.details) : ''}`).join('\n'),
    isLocal: local,
  };
}
