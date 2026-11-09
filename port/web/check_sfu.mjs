// The browser's WebRTC transport (www/sfu.js, finding 200) against the real Cloudflare Realtime SFU:
//   node port/web/check_sfu.mjs [ws://127.0.0.1:8787]
// The server is online/server under `wrangler dev`, with REALTIME_APP_ID and REALTIME_APP_TOKEN in
// its .dev.vars (gitignored; never committed). Headless Chrome or Edge (CHROME) opens a page where
// two players each run sfu.js with a stand-in for the net worker (the room WebSocket, the signalling
// copied to sfu.js, race frames through it): a room, both ready, the start (an SFU race), the
// release, then STATE at 60 a second and a few EVENTs each way through the SFU, with their slots.
import { readFileSync } from 'node:fs';
import { runPage } from './cdp.mjs';

const server = process.argv[2] || 'ws://127.0.0.1:8787', SECONDS = Number(process.argv[3] || 3);
const sfuJs = readFileSync(new URL('./www/sfu.js', import.meta.url));

const page = `<!doctype html><meta charset="utf-8"><script type="module">
import { startSfu } from './sfu.js';
const SERVER = ${JSON.stringify(server)}, TICKS = ${Math.round(SECONDS * 60)};
const log = [];
const say = t => log.push(t);
const SIGNAL = /^\\{"type":"(welcome|start|ended|error|sfu_[a-z_]+)"/;
const wait = (what, test, ms = 30000) => new Promise((ok, fail) => {
  const t0 = performance.now(), tick = () => { const v = test(); if (v) return ok(v);
    if (performance.now() - t0 > ms) return fail(Error('timed out: ' + what)); setTimeout(tick, 50); }; tick(); });

function player(name, path) {
  const p = { name, texts: [], got: [], released: false, start: null, welcome: null, route: false };
  const ch = new MessageChannel();
  if (!startSfu(ch.port1, t => say(name + ': ' + t))) throw Error('no RTCPeerConnection');
  const ws = new WebSocket(SERVER + path); ws.binaryType = 'arraybuffer';
  p.ws = ws;
  ws.onmessage = e => {
    if (typeof e.data !== 'string') { p.got.push({ via: 'socket', frame: new Uint8Array(e.data) }); return; }
    const m = JSON.parse(e.data);
    if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', s: m.s })); return; }
    p.texts.push(m);
    if (m.type === 'welcome') p.welcome = m;
    if (m.type === 'start') p.start = m;
    if (m.type === 'sfu_ready') p.released = true;
    if (m.type === 'error') say(name + ' error: ' + e.data);
    if (SIGNAL.test(e.data)) ch.port2.postMessage({ kind: 'signal', text: e.data });
  };
  ch.port2.onmessage = e => { const s = e.data;
    if (s.kind === 'text') { const m = JSON.parse(s.text); if (m.type.startsWith('sfu_')) say(name + ' -> ' + m.type); ws.send(s.text); }
    else if (s.kind === 'route') p.route = s.sfu;
    else if (s.kind === 'frame') p.got.push({ via: 'sfu', frame: new Uint8Array(s.data), at: performance.now() }); };
  p.sendFrame = bytes => { if (p.route) ch.port2.postMessage({ kind: 'frame', data: bytes.buffer }, [bytes.buffer]); else ws.send(bytes); };
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', protocol: 4, version: 'dhd-port sfu-check', clientVersion: '0.7.13',
    isoSha256: 'a'.repeat(64), name, features: ['race_rejoin'] }));
  return p;
}

window.result = (async () => {
  const host = player('HOST', '/v1/rooms/new');
  await wait('host welcome', () => host.welcome);
  const guest = player('GUEST', '/v1/rooms/' + host.welcome.code);
  await wait('guest welcome', () => guest.welcome);
  if (host.welcome.sfu === 'off') throw Error('the server has no Realtime (sfu off): put REALTIME_APP_ID/TOKEN in .dev.vars');
  // both sessions up: the room published their channels (sfu_channels with local ones)
  await wait('sessions connected', () => [host, guest].every(p => p.texts.some(m => m.type === 'sfu_channels')), 30000);
  for (const p of [host, guest]) p.ws.send(JSON.stringify({ type: 'ready', ready: true }));
  await new Promise(r => setTimeout(r, 500));
  host.ws.send(JSON.stringify({ type: 'start' }));
  await wait('start', () => host.start && guest.start);
  const transport = host.start.transport;
  const t0 = performance.now();
  await wait('release (sfu_ready)', () => host.released && guest.released, 30000);
  const releaseMs = performance.now() - t0;
  // 3 s of STATE at 60 a second each way, the counter in bytes 4-5; and 5 EVENTs each way
  for (let i = 0; i < TICKS; i++) {
    for (const [k, p] of [[0, host], [1, guest]]) {
      const f = new Uint8Array(200); f[0] = 5; f[1] = 9; f[2] = 6; f[3] = 0; f[4] = i & 255; f[5] = i >> 8; f[6] = k;
      new DataView(f.buffer).setFloat64(8, performance.now(), true);  // when it went, for its delay
      p.sendFrame(f);
      if (i % 36 === 0 && i < 180) { const ev = new Uint8Array(20); ev[0] = 6; ev[1] = 9; ev[2] = 2; ev[3] = 1; ev[4] = i / 36; p.sendFrame(ev); }
    }
    await new Promise(r => setTimeout(r, 16));
  }
  await new Promise(r => setTimeout(r, 1500));
  const slotOf = p => p.start.yourSlot;
  const summary = p => {
    const states = p.got.filter(g => g.frame[0] === 5), events = p.got.filter(g => g.frame[0] === 6);
    const gaps = []; for (let i = 1; i < states.length; i++) gaps.push(states[i].at - states[i - 1].at);
    gaps.sort((a, b) => a - b);
    const delay = states.map(g => g.at - new DataView(g.frame.buffer).getFloat64(8, true)).sort((a, b) => a - b);
    const q = f => Math.round(delay[Math.floor((delay.length - 1) * f)] || 0);
    return { states: states.length, events: events.length, via: [...new Set(p.got.map(g => g.via))],
      slots: [...new Set(p.got.map(g => g.frame[1]))], maxGapMs: Math.round(gaps.at(-1) || 0), p99GapMs: Math.round(gaps[Math.floor(gaps.length * 0.99)] || 0),
      over250: gaps.filter(x => x > 250).length, delayMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) } };
  };
  return { transport, releaseMs: Math.round(releaseMs), hostSlot: slotOf(host), guestSlot: slotOf(guest),
    host: summary(host), guest: summary(guest), log };
})().catch(e => ({ error: e.message, log }));
</script>`;

await runPage((req, res) => {
  const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
  if (req.url.startsWith('/sfu.js')) { res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }); res.end(sfuJs); return; }
  res.writeHead(200, { ...headers, 'Content-Type': 'text/html' }); res.end(page);
}, async ({ url, send, evaluate }) => {
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 1500));
  const r = await evaluate('window.result', { awaitPromise: true });
  console.log(JSON.stringify(r, null, 1));
  if (!r || r.error) { console.log('FAIL', r?.error); return 1; }
  const ok = r.transport === 'sfu' && r.host.via.includes('sfu') && r.guest.via.includes('sfu') &&
    r.host.states > SECONDS * 50 && r.guest.states > SECONDS * 50 && r.host.events === 5 && r.guest.events === 5 &&
    r.host.slots.length === 1 && r.host.slots[0] === r.guestSlot && r.guest.slots[0] === r.hostSlot;
  console.log(ok ? 'PASS' : 'FAIL');
  return ok ? 0 : 1;
}, { open: false });
