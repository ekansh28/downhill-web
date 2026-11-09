// Online in the browser (findings 190, 196): the native game's lobby client (port/net: client.c,
// json.c, net.c), built for the worker as build/dhd_net.wasm with its own memory
// (port/web/build_net.py), over the net worker's WebSocket (net_worker.js) in place of ws.h's Rust
// client. The game's host_service_net_* services arrive here with the game's addresses; each copies
// its strings and buffers into the client's memory and its answers back, byte for byte (both
// modules are wasm32).
//
// The sockets are the net worker's, so they never wait for this worker, which lets the browser in
// only at vsync: ws.h's calls go to it through a ring of commands (net_ring.js), and what the
// sockets did comes back through another, each record stamped with this worker's clock when it
// happened. The records are handed to the client before every service call and every 10 ms tick
// (so never inside a call into the client), each with the clock as it was then (web_now_ns), so a
// pong read late is still the real round trip and a stall is not a silent server. The net worker
// answers the server's pings itself and keeps a stalled race heard (net_worker.js).
//
// Voice chat (finding 183) is the net worker's too (dhd_voice.wasm): the others' voices are
// decoded there and played by the page's dhd-voice worklet (audio.js), the page's microphone ring
// (audio.js dhd-mic) is encoded there. The game's host_service_voice_* place and mute the slots in
// the shared words, hand it frames and drops through the ring, and read its state from the shared
// words. Whether the game wants the microphone (voice on, in a race) comes from the net worker;
// the page is told (host.wantMic) and answers through voiceMic.
import { Ring, OP, W, SLOTS, ringBuffer } from './net_ring.js';
const enc = new TextEncoder(), dec = new TextDecoder();

// host: { env: the worker's live environment (dhd.ini and ?env.), input: the page's input buffer
// (main.js; its keys for push-to-talk), mic: the microphone ring, voice: the page's voice ring
// (each a SharedArrayBuffer, or null), voiceBytes: dhd_voice.wasm, wantMic(on, device),
// startWorker(): the net worker (a Worker; the checks give Node's) }
export async function createNet(bytes, guest, say, host = {}) {
  let roomCode = '';  // the room this game is in, for host.room (the page's invite link)
  let roomTrack = -1;  // its track, for host.track (a streamed disc downloads its files first)
  let x, view;  // the client's exports and its memory, as bytes
  const mem = () => (view?.buffer === x.memory.buffer ? view : (view = new Uint8Array(x.memory.buffer)));
  const cstr = at => { const m = mem(); return dec.decode(m.subarray(at, m.indexOf(0, at))); };
  const words = (at, n) => new Uint32Array(x.memory.buffer, at, n);
  const call = (index, ...args) => x.__indirect_function_table.get(index)(...args);
  const envList = () => Object.entries(host.env || {}).map(([k, v]) => enc.encode(`${k}=${v}\0`));
  // The client's clock: now, or while a record is handed over, when it happened in the net worker.
  let clock = null;
  const now = () => clock ?? performance.now();
  let line = '';  // the client's stderr, by line
  const wasi = {
    fd_write: (fd, iovs, n, written) => { let total = 0;
      for (let i = 0; i < n; i++) { const [p, l] = words(iovs + 8 * i, 2); line += dec.decode(mem().subarray(p, p + l)); total += l; }
      for (let i; (i = line.indexOf('\n')) >= 0; line = line.slice(i + 1)) say(line.slice(0, i));
      words(written, 1)[0] = total; return 0; },
    // getenv (client.c's keep_ready): the environment as it is when the client first reads it
    environ_sizes_get: (count, size) => { const l = envList(); words(count, 1)[0] = l.length; words(size, 1)[0] = l.reduce((s, b) => s + b.length, 0); return 0; },
    environ_get: (ptrs, buf) => { for (const b of envList()) { words(ptrs, 1)[0] = buf; ptrs += 4; mem().set(b, buf); buf += b.length; } return 0; },
    clock_time_get: (_id, _precision, out) => { new BigUint64Array(x.memory.buffer, out, 1)[0] = BigInt(Math.round(now() * 1e6)); return 0; },
    fd_close: () => 0, fd_seek: () => 70, proc_exit: code => { throw Error(`dhd_net exited (${code})`); },
  };

  // ---- the net worker ----
  const commandsSab = ringBuffer(1 << 20), eventsSab = ringBuffer(1 << 21), sharedSab = new SharedArrayBuffer(4 * W.size);
  const commands = new Ring(commandsSab), events = new Ring(eventsSab), shared = new Int32Array(sharedSab);
  const worker = host.startWorker ? host.startWorker() : new Worker(new URL('./net_worker.js', import.meta.url), { type: 'module' });
  let workerVoice = false;
  const ready = new Promise(resolve => { worker.onmessage = e => { const m = e.data;
    if (m.type === 'log') say(m.text);
    else if (m.type === 'mic') host.wantMic?.(m.on, m.device);
    else if (m.type === 'ready') { workerVoice = m.voice; resolve(); } }; });
  const voiceEnv = () => Object.fromEntries(Object.entries(host.env || {}).filter(([k]) => k.startsWith('DHD_VOICE')));
  let sentEnv = JSON.stringify(voiceEnv());
  worker.postMessage({ type: 'start', commands: commandsSab, events: eventsSab, shared: sharedSab, input: host.input || null,
    mic: host.mic || null, voiceRing: host.voice || null, voiceBytes: host.voiceBytes || null, env: voiceEnv(),
    origin: performance.timeOrigin, sfuPort: host.sfuPort || null }, host.sfuPort ? [host.sfuPort] : []);
  let full = false;
  const command = (op, sock = 0, arg = 0, payload = null) => {
    if (commands.push(op, sock, 0, arg, payload)) return;
    if (!full) say('online: the net worker is behind: a command was dropped');
    full = true;
  };

  // ---- ws.h over the net worker's WebSocket ----
  // A connection: its handler's words {ctx, on_open, on_message, on_close, on_tick}, copied at
  // ws_start as the native client copies them (net.c's handler is on its stack). Each attempt has
  // its own socket number: a record for an earlier one is stale.
  const conns = new Map(), sockets = new Map(); let nextConn = 1, nextSocket = 1;
  const BACKOFF = [1000, 2000, 4000, 8000];
  function open(c, url) {
    c.sock = nextSocket++; c.opened = false; c.silent = false;
    sockets.set(c.sock, c);
    command(OP.OPEN, c.sock, 0, enc.encode(url));
  }
  // on_close says where to go next (a lobby drop rejoins the room by its code) after a backoff.
  function closed(c, code, reason) {
    sockets.delete(c.sock); c.sock = 0;
    if (!c.opened) c.attempt++;
    const r = enc.encode(reason + '\0'), at = x.malloc(r.length); mem().set(r, at);
    let next = 0;
    try { next = call(c.h[3], c.h[0], code, at, c.attempt); } finally { x.free(at); }
    if (!next || c.stopped) return;
    const url = cstr(next);
    c.retry = setTimeout(() => { if (!c.stopped) open(c, url); }, BACKOFF[Math.min(c.attempt, BACKOFF.length - 1)]);
  }
  const ALIVE = enc.encode('{"type":"alive"}');  // no type the client knows: only "heard from the server"
  function deliver(c, binary, data) {
    const at = x.malloc(data.length + 1);
    mem().set(data, at); mem()[at + data.length] = 0;
    try { call(c.h[2], c.h[0], binary, at, data.length); } finally { x.free(at); }
  }
  // What the sockets did, in order, each at its own time.
  function drain() {
    for (let e; (e = events.pop());) {
      const c = sockets.get(e.sock);
      if (!c || c.sock !== e.sock) continue;
      clock = e.t;
      try {
        if (e.op === OP.OPENED) { c.opened = true; c.attempt = 0; call(c.h[1], c.h[0], c.id); }
        else if (e.op === OP.TEXT) deliver(c, 0, e.payload);
        else if (e.op === OP.BINARY) deliver(c, 1, e.payload);
        else if (e.op === OP.ALIVE) deliver(c, 0, ALIVE);
        // the tick's drop of a silent server is a lost connection (1006), not the server's refusal (4000s)
        else if (e.op === OP.CLOSED) closed(c, !c.opened ? -1 : c.silent ? 1006 : e.arg, dec.decode(e.payload));
      } finally { clock = null; }
    }
    publish();
  }
  // the race as the net worker needs it (its voice, its keepalive)
  function publish() {
    if (!x) return;
    Atomics.store(shared, W.racing, x.host_service_net_racing());
    Atomics.store(shared, W.inRoom, x.net_voice_open());
    Atomics.store(shared, W.slot, x.net_local_slot() & 255);
  }
  const env = {
    web_now_ns: () => BigInt(Math.round(now() * 1e6)),
    ws_start: (url, h) => {
      const c = { id: nextConn++, h: [...words(h, 5)], attempt: 0, stopped: false, sock: 0 };
      conns.set(c.id, c);
      if (c.h[4]) c.tick = setInterval(() => { drain(); if (c.sock && c.opened && call(c.h[4], c.h[0])) { c.silent = true; command(OP.CLOSE, c.sock, 1000); } }, 10);
      open(c, cstr(url));
      return c.id;
    },
    ws_send: (id, binary, data, n) => { const c = conns.get(id); if (!c?.sock || !c.opened) return;
      command(binary ? OP.SEND_BINARY : OP.SEND_TEXT, c.sock, 0, mem().slice(data, data + n)); },
    // Sends nothing more (the net worker acts in order: what was queued goes before the close),
    // closes, and calls on_close for that close at once, as ws_stop's receive thread does before it
    // returns, so the client is told before net.c sets up the next room.
    ws_stop: id => { const c = conns.get(id); if (!c) return; conns.delete(id);
      c.stopped = true; clearInterval(c.tick); clearTimeout(c.retry);
      if (c.sock) { command(OP.CLOSE, c.sock, 1000); closed(c, 1000, ''); } },
    // The room list: the worker fetches it first (listStart), and the client reads that body here.
    http_get: (_url, out, cap) => { if (body === null) return -1;
      const b = enc.encode(body).subarray(0, cap - 1); mem().set(b, out); mem()[out + b.length] = 0; return b.length; },
  };
  let body = null;

  x = (await WebAssembly.instantiate(bytes, { env, wasi_snapshot_preview1: wasi })).instance.exports;
  x._initialize?.();
  await ready;
  const LOBBY = x.web_net_lobby_size(), INFO = x.web_net_info_size(), CHAT = x.web_net_chat_size(), FRAME_MAX = 3072, LIST_MAX = 64;
  const scratch = x.malloc(Math.max(LOBBY, INFO * LIST_MAX, CHAT, FRAME_MAX, 64));
  const copyIn = (at, n) => { const p = x.malloc(n); mem().set(guest.bytes(at, n), p); return p; };
  const stringIn = at => { const s = guest.bytes(at, guest.strlen(at) + 1); const p = x.malloc(s.length); mem().set(s, p); return p; };
  const withStrings = (addrs, f) => { const ps = addrs.map(a => a ? stringIn(a) : 0); try { return f(...ps); } finally { ps.forEach(p => p && x.free(p)); } };
  let base = '', list = { state: 'idle', text: null };
  // between fields too (the game's timers run only at vsync): the records in, voice's settings out
  let envAt = 0;
  setInterval(() => { drain();
    if (performance.now() - envAt < 250) return;
    envAt = performance.now();
    const v = JSON.stringify(voiceEnv());
    if (v !== sentEnv) { sentEnv = v; worker.postMessage({ type: 'env', env: JSON.parse(v) }); } }, 10);
  const muted = new Int8Array(SLOTS);

  const services = {
    // Online is offered in this browser build (upstream turns it off there, finding 195): net.c says 1.
    host_service_net_offered: () => 1,  // dhd_net.wasm doesn't export net.c's answer: the browser always offers online
    host_service_net_init: (a, b, c, d) => {
      base = a ? dec.decode(guest.bytes(a, guest.strlen(a))).replace(/\/+$/, '') : '';
      withStrings([a, b, c, d], x.host_service_net_init);
    },
    host_service_net_create_room: () => x.host_service_net_create_room(),
    host_service_net_join_room: a => withStrings([a], x.host_service_net_join_room),
    host_service_net_leave: () => x.host_service_net_leave(),
    host_service_net_get_lobby: out => { x.host_service_net_get_lobby(scratch); guest.bytes(out, LOBBY).set(mem().subarray(scratch, scratch + LOBBY));
      // the room's join code for the page's invite link (private rooms too: the presence leaves theirs out)
      const m = mem(), state = m[scratch] | m[scratch + 1] << 8, live = state >= 2 && state <= 4;  // NET_LOBBY, NET_RACING, NET_RECONNECTING
      const code = live ? String.fromCharCode(...m.subarray(scratch + 8, scratch + 16)).replace(/ .*$/s, '') : '';
      if (code !== roomCode) { roomCode = code; host.room?.(code); }
      // the room's track (NetLobby.track, net_web.c checks the place): a streamed disc gets its files first
      const track = live ? new DataView(m.buffer).getInt32(scratch + 140, true) : -1;
      if (track !== roomTrack) { roomTrack = track; host.track?.(track); } },
    // Text chat (finding 125): a line out, and the last lines (a NetChat) copied back.
    host_service_net_send_chat: a => withStrings([a], x.host_service_net_send_chat),
    host_service_net_get_chat: out => { x.host_service_net_get_chat(scratch); guest.bytes(out, CHAT).set(mem().subarray(scratch, scratch + CHAT)); },
    host_service_net_pick: (m, r, b) => x.host_service_net_pick(m, r, b),
    host_service_net_set_ready: r => x.host_service_net_set_ready(r),
    host_service_net_start_race: () => x.host_service_net_start_race(),
    host_service_net_racing: () => x.host_service_net_racing(),
    host_service_net_seconds: () => x.host_service_net_seconds(),
    host_service_net_server_ms: () => x.host_service_net_server_ms(),
    host_service_net_send_frame: (type, at, n) => { if (n > FRAME_MAX) return 0;
      mem().set(guest.bytes(at, n), scratch); return x.host_service_net_send_frame(type, scratch, n); },
    host_service_net_receive_frame: (out, max) => { const n = x.host_service_net_receive_frame(scratch, Math.min(max, FRAME_MAX));
      if (n > 0) guest.bytes(out, n).set(mem().subarray(scratch, scratch + n)); return n; },
    // NetRoomSettings as the game passes it (net.c's host_service_net_set_room): 7 words, the
    // last its room name's address (0: the name stays).
    host_service_net_set_room: at => { const p = copyIn(at, 28), w = words(p, 7), name = w[6] ? stringIn(w[6]) : 0;
      w[6] = name; try { x.host_service_net_set_room(p); } finally { x.free(p); if (name) x.free(name); } },
    // The room's rules and the race's end (online.c, online_menu.c): plain numbers, and the
    // rotation's track ids, copied in as the game passes them.
    host_service_net_finish: (ticks, place) => x.host_service_net_finish(ticks, place),
    host_service_net_back: () => x.host_service_net_back(),
    host_service_net_rules: (window, next, then) => x.host_service_net_rules(window, next, then),
    host_service_net_rotation: (at, count) => { if (count < 0 || count > 64) return;
      mem().set(guest.bytes(at, count), scratch); x.host_service_net_rotation(scratch, count); },
    host_service_net_end_race: () => x.host_service_net_end_race(),
  };
  // Every call into the client first hands it what the sockets did (cheap when nothing did).
  const net = Object.fromEntries(Object.entries(services).map(([k, f]) => [k, (...a) => { drain(); return f(...a); }]));

  return {
    ...net,
    // host_sdl.c's background fetch of the public list: start 1/0; poll -2 working, -1 failed,
    // else the count, the entries copied to the game's buffer.
    host_service_net_list_lobbies_start: max => {
      if (max <= 0 || max > LIST_MAX || list.state === 'working' || !base) return 0;
      list = { state: 'working', text: null };
      fetch(base.replace(/^ws/, 'http') + '/v1/lobbies').then(r => r.ok ? r.text() : Promise.reject(Error(`${r.status}`)))
        .then(t => { list = { state: 'done', text: t }; }, e => { say(`online: room list: ${e.message}`); list = { state: 'failed' }; });
      return 1;
    },
    host_service_net_list_lobbies_poll: (out, max) => {
      if (list.state === 'working') return -2;
      if (list.state !== 'done') { list = { state: 'idle' }; return -1; }
      body = list.text; list = { state: 'idle' };
      let n;
      try { n = x.host_service_net_list_lobbies(scratch, Math.min(max, LIST_MAX)); } finally { body = null; }
      if (n > 0) guest.bytes(out, n * INFO).set(mem().subarray(scratch, scratch + n * INFO));
      return n;
    },
    // DHD_HASH_LOG's state hashes (online.c): a debugging log, none in the browser.
    host_service_net_hash_ranges: () => 0n,
    // Voice chat (voice.c, in the net worker): the game's side. A frame the game hands over comes
    // from its memory; a drop goes in order with the frames.
    host_service_voice_frame: (slot, at, n) => { if (n > 0 && n <= FRAME_MAX) command(OP.VOICE_FRAME, 0, slot, guest.bytes(at, n).slice()); },
    host_service_voice_place: (slot, gain, pan) => { if (slot < 0 || slot >= SLOTS) return;
      Atomics.store(shared, W.gain + slot, gain); Atomics.store(shared, W.pan + slot, pan); },
    host_service_voice_mute: (slot, on) => { if (slot < 0 || slot >= SLOTS) return;
      muted[slot] = on ? 1 : 0; Atomics.store(shared, W.muted + slot, muted[slot]); },
    host_service_voice_drop: slot => command(OP.VOICE_DROP, 0, slot),
    // voice.c's host_service_voice_state as the net worker last left it (every 10 ms); muted is
    // the game's own, at once
    host_service_voice_state: (field, slot) => {
      const inSlot = slot >= 0 && slot < SLOTS;
      switch (field) {
      case 0: return Atomics.load(shared, W.enabled);
      case 1: return Atomics.load(shared, W.transmitting);
      case 2: return workerVoice ? Atomics.load(shared, W.mic) : -1;
      case 3: return Atomics.load(shared, W.level);
      case 4: return inSlot && !muted[slot] ? Atomics.load(shared, W.talking + slot) : 0;
      case 5: return inSlot ? muted[slot] : 0;
      case 6: return Atomics.load(shared, W.key);
      case 7: return inSlot ? Atomics.load(shared, W.speak + slot) : 0;
      }
      return 0;
    },
    // The page's microphone: 1 open, -1 refused or none (the HUD's NO MICROPHONE).
    voiceMic: state => worker.postMessage({ type: 'mic-state', state }),
    // A text field has the keys (worker.js): no push-to-talk.
    textInput: on => Atomics.store(shared, W.textActive, on ? 1 : 0),
    // The status line's and the checks' counters (net_ring.js W).
    stats: () => ({ pongs: Atomics.load(shared, W.pongs), keepalives: Atomics.load(shared, W.keepalives),
      voiceMixed: Atomics.load(shared, W.mixed), micFrames: Atomics.load(shared, W.voiceFrames) }),
  };
}
