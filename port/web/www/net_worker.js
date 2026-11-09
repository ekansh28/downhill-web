// The net worker (finding 196): the online game's WebSocket and voice chat, in a worker of their
// own, so neither waits for the game worker, which lets the browser in only at vsync (and not at
// all through a long field or a stall).
//
// The lobby client (port/net, dhd_net.wasm) stays in the game worker (net.js), so the game's
// host_service_net_* stay synchronous calls into it. This worker holds the sockets it asks for:
// commands come through one ring (net_ring.js: open, send, close, in the order the client made
// them; the worker waits on it with Atomics.waitAsync and acts at once), and what the sockets do
// goes back through another, each record stamped with the game worker's clock when it happened
// here. net.js hands the client each record with its clock at that time, so a pong read a field
// late still measures the real round trip and the server's clock, and a long stall is not taken
// for a silent server (client.c's SILENT_MS: what arrived meanwhile was heard when it arrived).
// The wire is unchanged: the same messages, in the same order, as the native client's.
//
// Answered here, whatever the game worker is doing:
// - the server's lobby ping ({"type":"ping","s"}) gets the client's pong at once; the game is
//   told something arrived (ALIVE) but not asked to answer it again;
// - in a race, a ping frame (as client_tick's: [PING, slot, the game's clock]) goes out whenever
//   the game has sent nothing for KEEPALIVE_MS, so the server never takes a stalled game for a
//   silent racer (room.ts RACE_SILENT_MS); its pong reaches the client as any other, a true round
//   trip on the game's clock.
//
// WebRTC (finding 200): with the page's SFU module (sfu.js, over m.sfuPort), the room's signalling
// (welcome, start, ended, sfu_*) is copied to it, and in a race it routes (an SFU race) the game's
// STATE and EVENT frames go to it instead of the socket; the frames it got over the SFU come back
// here and go on as if the socket had brought them (voice to its decoder, the rest to the game).
//
// Voice chat (finding 183; port/host/voice.c with libopus, dhd_voice.wasm) runs here too. Its
// packets come straight from the socket (while the game races, as client.c's net_voice_hook);
// every TICK_MS the others' voices are mixed, at the gain and pan the game last gave each slot
// (the shared words), into the page's voice ring up to VOICE_AHEAD_MS ahead, which audio.js's
// dhd-voice worklet plays in real time; the microphone ring (audio.js dhd-mic) is encoded 20 ms at
// a time and sent on the race's socket. voice.c's own queue (two to eight packets, by sequence)
// is the jitter buffer. The game reads voice chat's state from the shared words.
import { Ring, OP, W, SLOTS } from './net_ring.js';

const node = !globalThis.WorkerGlobalScope;  // the checks run this in Node's worker_threads
const parent = node ? (await import('node:worker_threads')).parentPort : null;
const post = m => node ? parent.postMessage(m) : postMessage(m);
const enc = new TextEncoder(), dec = new TextDecoder();
const TICK_MS = 10, KEEPALIVE_MS = 1000, VOICE_FRAME = 960, VOICE_AHEAD_MS = 50, ALIVE_MS = 100;
const NET_FRAME_PING = 3, NET_FRAME_EVENT = 6, NET_FRAME_VOICE = 7, VOICE_VERSION = 2, VOICE_KIND = 11;

let started = null;
const early = [];
const listen = f => node ? parent.on('message', f) : (onmessage = e => f(e.data));
listen(m => { if (m.type === 'start') started = start(m); else if (started) started.then(h => h(m)); else early.push(m); });

async function start(m) {
  const commands = new Ring(m.commands), events = new Ring(m.events), shared = new Int32Array(m.shared);
  const keys = m.input ? new Uint8Array(m.input, 0, 256) : null;
  const gameNow = () => performance.timeOrigin + performance.now() - m.origin;  // the game worker's performance.now
  let env = { ...m.env };
  const say = text => post({ type: 'log', text });

  // ---- what the sockets did, back to the game ----
  const waiting = [];  // records the events ring had no room for yet, in order
  function tell(op, sock, arg = 0, payload = null, t = gameNow()) {
    if (waiting.length || !events.push(op, sock, t, arg, payload)) waiting.push([op, sock, t, arg, payload]);
  }
  function flush() { while (waiting.length && events.push(...waiting[0])) waiting.shift(); }

  // ---- the page's SFU module (sfu.js) ----
  const sfu = m.sfuPort || null;
  let sfuRace = false;  // this race's frames go over the SFU (the module says, at its start)
  const SIGNAL = /^\{"type":"(welcome|start|ended|error|sfu_[a-z_]+)"/;

  // ---- the sockets ----
  const sockets = new Map(); let current = 0, sentAt = 0, aliveAt = 0;
  const racing = () => Atomics.load(shared, W.racing) !== 0;
  const inRoom = () => Atomics.load(shared, W.inRoom) !== 0;
  function open(sock, url) {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { say(`online: ${e.message}`); tell(OP.CLOSED, sock, 1006, enc.encode(e.message)); return; }
    ws.binaryType = 'arraybuffer';
    sockets.set(sock, ws);
    ws.onopen = () => { current = sock; tell(OP.OPENED, sock); };
    ws.onmessage = e => {
      const t = gameNow();
      if (typeof e.data === 'string') {
        if (e.data.startsWith('{"type":"ping"')) {  // client.c's answer, from here
          let s; try { s = JSON.parse(e.data).s; } catch {}
          if (Number.isInteger(s)) { ws.send(`{"type":"pong","s":${s}}`); Atomics.add(shared, W.pongs, 1); tell(OP.ALIVE, sock, 0, null, t); return; }
        }
        if (sfu && SIGNAL.test(e.data)) sfu.postMessage({ kind: 'signal', text: e.data });
        tell(OP.TEXT, sock, 0, enc.encode(e.data), t);
        return;
      }
      arrived(sock, new Uint8Array(e.data), t);
    };
    ws.onclose = e => { sockets.delete(sock); if (current === sock) current = 0; tell(OP.CLOSED, sock, e.code, enc.encode(e.reason || '')); };
  }
  // A race frame from the socket or the SFU: voice to its decoder, the rest to the game.
  function arrived(sock, data, t) {
      if (data.length >= 4 && (data[0] === NET_FRAME_EVENT || data[0] === NET_FRAME_VOICE) && data[2] === VOICE_VERSION && data[3] === VOICE_KIND) {
        if (voice && (data[0] === NET_FRAME_VOICE ? inRoom() : racing())) hear(data[1], data.subarray(2));
        if (t - aliveAt >= ALIVE_MS) { aliveAt = t; tell(OP.ALIVE, sock, 0, null, t); }
        return;
      }
      tell(OP.BINARY, sock, 0, data, t);
  }
  if (sfu) sfu.onmessage = e => { const s = e.data;
    if (s.kind === 'text') { const ws = sockets.get(current); if (ws?.readyState === 1) ws.send(s.text); }
    else if (s.kind === 'route') sfuRace = !!s.sfu;
    else if (s.kind === 'frame' && current) arrived(current, new Uint8Array(s.data), gameNow());
  };
  function send(sock, data, binary) {
    if (binary && sfuRace && (data[0] === 5 || data[0] === 6 || data[0] === 7)) {  // an SFU race's frame: the page sends it
      const copy = data.slice();
      sfu.postMessage({ kind: 'frame', data: copy.buffer }, [copy.buffer]);
      sentAt = gameNow();
      if (data[0] !== 7) return true;  // voice goes to the room too, for the members watching (room.ts)
    }
    const ws = sockets.get(sock);
    if (ws?.readyState !== 1) return false;
    ws.send(binary ? data : dec.decode(data));
    if (binary) sentAt = gameNow();
    return true;
  }
  function command(c) {
    switch (c.op) {
    case OP.OPEN: open(c.sock, dec.decode(c.payload)); break;
    case OP.SEND_TEXT: send(c.sock, c.payload, false); break;
    case OP.SEND_BINARY: send(c.sock, c.payload, true); break;
    case OP.CLOSE: { const ws = sockets.get(c.sock); try { ws?.close(c.arg); } catch {} break; }
    case OP.VOICE_FRAME: if (voice) hear(c.arg, c.payload); break;
    case OP.VOICE_DROP: voice?.host_service_voice_drop(c.arg); break;
    }
  }
  // The commands as soon as they come: wait on the ring's write word, act, wait again.
  (async () => {
    for (;;) {
      for (let c; (c = commands.pop());) command(c);
      const seen = Atomics.load(commands.head, 0);
      if (seen !== Atomics.load(commands.head, 1)) continue;
      const w = Atomics.waitAsync(commands.head, 0, seen);
      if (w.async) await w.value;
    }
  })().catch(e => say(`online: net worker: ${e.stack || e}`));

  // ---- voice chat ----
  let voice = null, vmem = null, line = '';
  const vbytes = () => (vmem?.buffer === voice.memory.buffer ? vmem : (vmem = new Uint8Array(voice.memory.buffer)));
  const vstr = at => { const b = vbytes(); return dec.decode(b.subarray(at, b.indexOf(0, at))); };
  const vwords = (at, n) => new Uint32Array(voice.memory.buffer, at, n);
  if (m.voiceBytes) {
    const imports = {
      env: {
        web_now_ns: () => BigInt(Math.round(performance.now() * 1e6)),
        web_getenv: (name, out, cap) => { const v = env[vstr(name)]; if (v === undefined || v === '') return 0;
          const b = enc.encode(String(v)).subarray(0, cap - 1); vbytes().set(b, out); vbytes()[out + b.length] = 0; return 1; },
        web_key_held: k => +(k > 0 && k < 256 && !!keys && !Atomics.load(shared, W.textActive) && Atomics.load(keys, k) !== 0),
        web_net_voice_open: () => +inRoom(),
        // client_send_frame's frame: [type, 0 (the server stamps the slot), payload], while racing
        web_net_send: (type, at, n) => { if (!(type === NET_FRAME_VOICE ? inRoom() : racing()) || !current || n < 0 || n > 3070) return 0;
          const f = new Uint8Array(n + 2); f[0] = type; f.set(vbytes().subarray(at, at + n), 2); return +send(current, f, true); },
      },
      wasi_snapshot_preview1: {
        fd_write: (fd, iovs, n, written) => { let total = 0;
          for (let i = 0; i < n; i++) { const [p, l] = vwords(iovs + 8 * i, 2); line += dec.decode(vbytes().subarray(p, p + l)); total += l; }
          for (let i; (i = line.indexOf('\n')) >= 0; line = line.slice(i + 1)) say(line.slice(0, i));
          vwords(written, 1)[0] = total; return 0; },
        clock_time_get: (_id, _precision, out) => { new BigUint64Array(voice.memory.buffer, out, 1)[0] = BigInt(Math.round(performance.now() * 1e6)); return 0; },
        fd_close: () => 0, fd_seek: () => 70,
      },
    };
    try {
      voice = (await WebAssembly.instantiate(m.voiceBytes, imports)).instance.exports;
      voice._initialize?.();
      voice.voice_open();
    } catch (e) { say(`voice: no voice chat (${e.message})`); voice = null; }
  }
  const packet = voice ? voice.malloc(3072) : 0;
  function hear(slot, payload) {
    if (payload.length > 3072) return;
    vbytes().set(payload, packet); voice.host_service_voice_frame(slot, packet, payload.length);
  }
  const out = m.voiceRing ? { head: new Int32Array(m.voiceRing, 0, 4), data: new Int16Array(m.voiceRing, 16) } : null;
  if (out) out.frames = out.data.length / 2;
  let mix = 0, mixFrames = 0;
  function mixAhead() {
    const h = out.head, w = Atomics.load(h, 0), r = Atomics.load(h, 1);
    const n = Math.min(out.frames, VOICE_AHEAD_MS * 48) - ((w - r) | 0);
    if (n <= 0) return;
    if (n > mixFrames) { if (mix) voice.free(mix); mix = voice.malloc(n * 4); mixFrames = n; }
    const pcm = new Int16Array(voice.memory.buffer, mix, n * 2); pcm.fill(0);
    voice.voice_mix(mix, n);
    const done = new Int16Array(voice.memory.buffer, mix, n * 2);
    for (let i = 0; i < n; i++) { const at = (((w + i) >>> 0) % out.frames) * 2; out.data[at] = done[i * 2]; out.data[at + 1] = done[i * 2 + 1]; }
    Atomics.store(h, 0, (w + n) | 0);
    Atomics.add(shared, W.mixed, n);
  }
  const mic = m.mic ? { head: new Int32Array(m.mic, 0, 2), data: new Int16Array(m.mic, 8), cap: (m.mic.byteLength - 8) / 2 } : null;
  const pcm = voice ? voice.malloc(VOICE_FRAME * 2) : 0;
  let wanted = false, device = '';
  function capture() {
    const want = !!voice.voice_web_wanted(), now = String(env.DHD_VOICE_DEVICE || '');
    // on or off, or SETTINGS > Microphone chose another while it is open (the page opens it)
    if (want !== wanted || (want && now !== device)) { wanted = want; device = now; post({ type: 'mic', on: want, device: now });
      if (!mic && want) voice.voice_web_mic(-1); }
    if (!mic) return;
    let r = Atomics.load(mic.head, 1); const w = Atomics.load(mic.head, 0);
    while ((w - r + mic.cap) % mic.cap >= VOICE_FRAME) {
      const frame = new Int16Array(voice.memory.buffer, pcm, VOICE_FRAME);
      for (let i = 0; i < VOICE_FRAME; i++) frame[i] = mic.data[(r + i) % mic.cap];
      r = (r + VOICE_FRAME) % mic.cap;
      if (wanted) { voice.voice_web_capture(pcm, VOICE_FRAME); Atomics.add(shared, W.voiceFrames, 1); }
    }
    Atomics.store(mic.head, 1, r);
  }
  function voiceState() {
    for (let slot = 0; slot < SLOTS; slot++) {
      voice.host_service_voice_place(slot, Atomics.load(shared, W.gain + slot), Atomics.load(shared, W.pan + slot));
      voice.host_service_voice_mute(slot, Atomics.load(shared, W.muted + slot));
    }
    for (const [word, field] of [[W.enabled, 0], [W.transmitting, 1], [W.mic, 2], [W.level, 3], [W.key, 6]])
      Atomics.store(shared, word, voice.host_service_voice_state(field, 0));
    for (let slot = 0; slot < SLOTS; slot++) {
      Atomics.store(shared, W.talking + slot, voice.host_service_voice_state(4, slot));
      Atomics.store(shared, W.speak + slot, voice.host_service_voice_state(7, slot));
    }
  }

  setInterval(() => {
    flush();
    // a race's keepalive: nothing sent lately (the game is stalled), so a ping as client_tick's
    const now = gameNow();
    if (racing() && current && now - sentAt >= KEEPALIVE_MS) {
      const f = new Uint8Array(10); f[0] = NET_FRAME_PING; f[1] = Atomics.load(shared, W.slot);
      new DataView(f.buffer).setFloat64(2, now, true);
      if (send(current, f, true)) Atomics.add(shared, W.keepalives, 1);
    }
    if (!voice) return;
    voiceState();
    capture();
    if (out) mixAhead();
  }, TICK_MS);

  const handle = msg => {
    if (msg.type === 'env') env = { ...msg.env };
    else if (msg.type === 'mic-state') voice?.voice_web_mic(msg.state);
  };
  early.splice(0).forEach(handle);
  post({ type: 'ready', voice: !!voice });
  return handle;
}
