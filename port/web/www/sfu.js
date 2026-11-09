// The browser's WebRTC transport to Cloudflare Realtime SFU (finding 200; docs/online-protocol.md,
// "Race (binary frames)" and "SFU signaling"): what port/render/net/src/sfu.rs does for the native
// game, on the page's own thread, as RTCPeerConnection exists only there (not in workers).
//
// The net worker (net_worker.js) keeps the room's WebSocket. It copies this module the room's
// signalling (welcome, start, ended and every sfu_* message) and, in an SFU race, the game's race
// frames (STATE 5, EVENT 6) through a MessagePort; this module answers with signalling to send on
// the room socket and the race frames that came over the SFU, which the net worker hands the game
// as if they had come on the socket. The game and client.c see no difference.
//
// One session for the room stay (finding 177): an offer after each welcome without "sfu":"ready",
// kept across races. Each racer publishes `state` (unordered, no retransmits) and `events`
// (reliable, ordered); the room allocates them and the subscriptions and sends this game its own
// channel ids (sfu_channels), which become negotiated DataChannels here. Every message carries an
// 8-byte little-endian prefix, the race's startAt; older races' are dropped, early events wait for
// their start (bounded). After a race's start, once this game's channels and every other racer's
// are open (or 8 s after the start with its own open), sfu_ready; frames wait here until the room
// answers sfu_ready (the race is released). A welcome with "sfu":"off" or a relay race ("transport":
// "relay", finding 199): nothing here; the net worker sends on the socket.
//
// Cloudflare forwards a subscriber's channels ordered and reliable whatever was asked (finding
// 173); the browser's SCTP can't be patched as the native game's is, so a lost chunk may hold later
// snapshots until Cloudflare resends it. The game takes the newest snapshot it has, so a late one
// is harmless, but a stall shows as a frozen rider for that moment.

const READY_TIMEOUT_MS = 8000, CONNECT_TIMEOUT_MS = 10000, OPEN_LIMIT_MS = 10000;
const EARLY_EVENTS = 128, HELD_EVENTS = 512, PROBE_ID = 1023;
const FRAME_STATE = 5, FRAME_EVENT = 6;

export function startSfu(port, say = () => {}) {
  if (typeof RTCPeerConnection !== 'function') return false;
  let pc = null, answered = false, connected = false, attempt = 0, pause = 1000, retryAt = 0, retryTimer = 0;
  let me = -1, race = null, released = false, readySent = false, readyTimer = 0, connectTimer = 0;
  const channels = new Map();   // channelId -> { memberId, name, local, dc, at }
  const closing = new Map();    // channelId -> a DataChannel still closing (its id can't be reused yet)
  const waiting = new Map();    // channelId -> an allocation waiting for its id's close
  const early = [];             // events for a race this game hasn't seen start yet
  let heldState = new Map(), heldEvents = [];  // frames before the release: the newest STATE per bundle index
  const signal = m => port.postMessage({ kind: 'text', text: JSON.stringify(m) });
  const route = on => port.postMessage({ kind: 'route', sfu: on });

  function teardown() {
    clearTimeout(connectTimer); clearTimeout(readyTimer);
    for (const c of channels.values()) try { c.dc?.close(); } catch {}
    channels.clear(); closing.clear(); waiting.clear();
    try { pc?.close(); } catch {}
    pc = null; answered = connected = false;
  }
  function failed(why) {
    say(`net: SFU: ${why}; a new session in ${(pause / 1000).toFixed(0)} s`);
    teardown();
    retryAt = performance.now() + pause;
    pause = Math.min(60000, pause * 2);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (!pc && me >= 0) offer(); }, pause);
  }

  async function offer() {
    teardown();
    const mine = ++attempt;
    pc = new RTCPeerConnection({ iceServers: [] });
    // the offer needs the SCTP transport: one negotiated channel nobody uses, on an id the room's
    // allocations don't reach in practice
    pc.createDataChannel('probe', { negotiated: true, id: PROBE_ID });
    pc.onconnectionstatechange = () => {
      if (mine !== attempt) return;
      const s = pc.connectionState;
      if (s === 'connected' && !connected) {
        connected = true; pause = 1000; clearTimeout(connectTimer);
        say('net: SFU: connected');
        signal({ type: 'sfu_connected' });
      } else if (s === 'failed' || (s === 'disconnected' && connected)) failed(`connection ${s}`);
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      // every candidate in the one offer: the room's signalling has no trickle
      if (pc.iceGatheringState !== 'complete')
        await new Promise(done => {
          const t = setTimeout(done, 3000);
          pc.addEventListener('icegatheringstatechange', () => { if (pc?.iceGatheringState === 'complete') { clearTimeout(t); done(); } });
        });
      if (mine !== attempt) return;
      signal({ type: 'sfu_offer', sdp: pc.localDescription.sdp });
      connectTimer = setTimeout(() => { if (mine === attempt && !connected) failed('no connection (UDP blocked?)'); }, CONNECT_TIMEOUT_MS);
    } catch (e) { if (mine === attempt) failed(`offer: ${e.message}`); }
  }

  function open(a) {
    if (closing.has(a.channelId)) { waiting.set(a.channelId, a); return; }
    const state = a.name === 'state';
    const dc = pc.createDataChannel(a.name, { negotiated: true, id: a.channelId, ordered: !state, ...(state ? { maxRetransmits: 0 } : {}) });
    dc.binaryType = 'arraybuffer';
    const c = { ...a, dc, at: performance.now() };
    channels.set(a.channelId, c);
    dc.onopen = () => checkReady();
    if (!a.local) dc.onmessage = e => receive(c, new Uint8Array(e.data));
    dc.onclose = () => {
      if (channels.get(a.channelId) === c) channels.delete(a.channelId);
      closing.delete(a.channelId);
      const next = waiting.get(a.channelId);
      if (next) { waiting.delete(a.channelId); open(next); }
    };
  }
  function close(id) {
    const c = channels.get(id);
    channels.delete(id); waiting.delete(id);
    if (c?.dc && c.dc.readyState !== 'closed') { closing.set(id, c.dc); try { c.dc.close(); } catch {} }
  }
  const same = (c, a) => c.memberId === a.memberId && c.name === a.name && !!c.local === !!a.local;
  function allocations(list, full) {
    if (!pc) return;
    if (full) for (const [id, c] of channels) if (!list.some(a => a.channelId === id && same(c, a))) close(id);
    for (const a of list) {
      const c = channels.get(a.channelId);
      if (c && same(c, a)) continue;
      if (c) close(a.channelId);
      open(a);
    }
    checkReady();
  }

  // ---- the race ----
  const racers = () => (race?.players || []).map(p => p.memberId).filter(id => id !== me);
  const openFor = (member, local) => ['state', 'events'].every(name =>
    [...channels.values()].some(c => c.memberId === member && c.name === name && !!c.local === local && c.dc.readyState === 'open'));
  function checkReady() {
    if (!race || readySent || !connected) return;
    if (!openFor(me, true)) return;
    if (racers().every(id => openFor(id, false))) sendReady();
  }
  function sendReady() {
    if (readySent || !race) return;
    readySent = true; clearTimeout(readyTimer);
    signal({ type: 'sfu_ready', race: race.startAt });
  }
  function startRace(m) {
    race = m; released = false; readySent = false;
    heldState = new Map(); heldEvents = [];
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => { if (race === m && openFor(me, true)) sendReady(); }, READY_TIMEOUT_MS);
    route(true);
    for (const f of early.splice(0)) if (f.at === m.startAt) deliver(f.member, f.frame);
    checkReady();
  }
  function endRace() { race = null; released = false; readySent = false; heldState = new Map(); heldEvents = []; route(false); }

  // a frame with its race marker, from member's channel
  function receive(c, bytes) {
    if (bytes.length < 10) return;
    const at = Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true)), frame = bytes.slice(8);
    if (race && at === race.startAt) { deliver(c.memberId, frame); return; }
    if (!race || at > race.startAt) {  // a race this game hasn't started yet: its events wait (bounded), STATE goes
      if (frame[0] === FRAME_EVENT && early.length < EARLY_EVENTS) early.push({ at, member: c.memberId, frame });
    }
  }
  function deliver(member, frame) {
    const p = race?.players?.find(x => x.memberId === member);
    if (!p) return;
    frame[1] = p.slot;  // the sender's race slot, as the room stamps it on the socket
    port.postMessage({ kind: 'frame', data: frame }, [frame.buffer]);
  }
  function send(frame) {
    if (!race) return;
    if (!released) {  // until the room releases the race: the newest STATE per bundle, every EVENT
      if (frame[0] === FRAME_STATE) heldState.set(frame[3] ?? 0, frame);
      else if (heldEvents.length < HELD_EVENTS) heldEvents.push(frame);
      return;
    }
    const name = frame[0] === FRAME_STATE ? 'state' : 'events';
    const c = [...channels.values()].find(x => x.local && x.memberId === me && x.name === name && x.dc.readyState === 'open');
    if (!c) return;
    // A congested link: snapshots waiting in the channel are stale by the time they'd go, so keep at
    // most a few there (a stall on the live site queued 64 KiB, 5 s of them: riders 13 s late). The
    // newest one is the one worth sending; the next tick's will be newer still.
    if (name === 'state' && c.dc.bufferedAmount > Math.max(4096, 4 * (frame.length + 8))) return;
    const out = new Uint8Array(8 + frame.length);
    new DataView(out.buffer).setBigUint64(0, BigInt(race.startAt), true);
    out.set(frame, 8);
    try { c.dc.send(out); } catch {}
  }
  function release() {
    released = true;
    for (const f of heldEvents.splice(0)) send(f);
    for (const f of heldState.values()) send(f);
    heldState = new Map();
  }

  port.onmessage = e => {
    const m = e.data;
    if (m.kind === 'frame') { send(new Uint8Array(m.data)); return; }
    if (m.kind !== 'signal') return;
    let msg;
    try { msg = JSON.parse(m.text); } catch { return; }
    switch (msg.type) {
    case 'welcome':
      if (msg.sfu === 'off') { if (pc) say('net: SFU: the room relays its races; no session'); teardown(); me = -1; endRace(); return; }
      if (Number.isInteger(msg.memberId)) me = msg.memberId;
      if (msg.sfu === 'ready' && pc && answered) return;  // a rejoin: the session stays (sfu_channels full follows)
      if (performance.now() >= retryAt || !pc) offer();
      return;
    case 'sfu_answer':
      if (!pc) return;
      pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).then(() => { answered = true; }, err => failed(`answer: ${err.message}`));
      return;
    case 'sfu_channels': allocations(msg.channels || [], !!msg.full); return;
    case 'sfu_closed': for (const id of msg.channelIds || []) close(id); return;
    case 'sfu_ready': if (race && msg.race === race.startAt) release(); return;
    case 'sfu_reset': failed('the room ended this game\'s session'); return;
    case 'start':
      if (msg.transport === 'relay' || !pc) { endRace(); return; }  // the room relays this race (finding 199)
      startRace(msg);
      return;
    case 'ended': endRace(); return;
    case 'error':
      if (/Realtime connection failed/.test(msg.message || '')) failed('the room gave up on this session');
      return;
    }
  };
  // a channel that never opens fails the session (as sfu.rs OPEN_LIMIT)
  setInterval(() => {
    const now = performance.now();
    for (const c of channels.values()) if (c.dc.readyState === 'connecting' && now - c.at > OPEN_LIMIT_MS) { failed(`channel ${c.channelId} never opened`); return; }
  }, 1000);
  return true;
}
