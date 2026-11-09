// The game worker and the net worker (finding 196: net.js, net_worker.js) talk through
// SharedArrayBuffers, never through messages, because the game worker reads its messages only at
// vsync.
//
// A Ring is one writer's and one reader's queue of records: a header [write, read] as running byte
// counts (Int32, they wrap; the index is the count modulo the size, a power of two), then the
// bytes. A record is its length (u32), then op (u8), sock (u32), t (f64: the game worker's clock,
// ms), arg (i32) and the payload. The writer notifies the write word, so a reader can wait on it
// (Atomics.waitAsync).
export const OP = {
  // game -> net
  OPEN: 1, SEND_TEXT: 2, SEND_BINARY: 3, CLOSE: 4, VOICE_FRAME: 5, VOICE_DROP: 6,
  // net -> game
  OPENED: 16, TEXT: 17, BINARY: 18, CLOSED: 19, ALIVE: 20,
};
const HEAD = 8, FIXED = 17;
export const ringBuffer = bytes => new SharedArrayBuffer(HEAD + bytes);
export class Ring {
  constructor(sab) {
    this.head = new Int32Array(sab, 0, 2); this.data = new Uint8Array(sab, HEAD); this.mask = this.data.length - 1;
    if (this.data.length & this.mask) throw Error('a ring is a power of two');
    this.fixed = new DataView(new ArrayBuffer(4 + FIXED)); this.fixedBytes = new Uint8Array(this.fixed.buffer);
  }
  put(at, src) { const i = at & this.mask, first = Math.min(src.length, this.data.length - i);
    this.data.set(src.subarray(0, first), i); if (first < src.length) this.data.set(src.subarray(first), 0); }
  take(at, n) { const out = new Uint8Array(n), i = at & this.mask, first = Math.min(n, this.data.length - i);
    out.set(this.data.subarray(i, i + first)); if (first < n) out.set(this.data.subarray(0, n - first), first); return out; }
  // false when it doesn't fit (nothing written)
  push(op, sock = 0, t = 0, arg = 0, payload = null) {
    const n = payload ? payload.length : 0, size = 4 + FIXED + n, h = this.head;
    const w = Atomics.load(h, 0), r = Atomics.load(h, 1);
    if (this.data.length - ((w - r) | 0) < size) return false;
    const f = this.fixed;
    f.setUint32(0, FIXED + n, true); f.setUint8(4, op); f.setUint32(5, sock, true); f.setFloat64(9, t, true); f.setInt32(17, arg, true);
    this.put(w, this.fixedBytes);
    if (n) this.put(w + 4 + FIXED, payload);
    Atomics.store(h, 0, (w + size) | 0); Atomics.notify(h, 0);
    return true;
  }
  // the next record, its payload a copy, or null
  pop() {
    const h = this.head, w = Atomics.load(h, 0), r = Atomics.load(h, 1);
    if (w === r) return null;
    const f = new DataView(this.take(r, 4 + FIXED).buffer), n = f.getUint32(0, true) - FIXED;
    const e = { op: f.getUint8(4), sock: f.getUint32(5, true), t: f.getFloat64(9, true), arg: f.getInt32(17, true),
      payload: this.take(r + 4 + FIXED, n) };
    Atomics.store(h, 1, (r + 4 + FIXED + n) | 0);
    return e;
  }
}

// The shared words (Int32): the game's side of the race and of voice chat, written by net.js and
// read by the net worker, and voice chat's state, written by the net worker and read by the game's
// host_service_voice_state. A slot's words are its base + the slot.
export const SLOTS = 10;
export const W = {
  racing: 0, slot: 1, textActive: 2,
  gain: 8, pan: 18, muted: 28,                            // host_service_voice_place / mute, x1000
  enabled: 40, transmitting: 41, mic: 42, level: 43, key: 44,
  talking: 45, speak: 55,                                 // VOICE_STATE_TALKING, SPEAK_LEVEL per slot
  pongs: 65, keepalives: 66, mixed: 67, voiceFrames: 68,  // counters (the status line, the checks)
  size: 72,
};
// The others' voices for the page (audio.js dhd-voice): [write, read, runs dry, -] as running frame
// counts, then 48 kHz stereo 16-bit samples; 0.25 s of them.
export const voiceRingBuffer = () => new SharedArrayBuffer(16 + 12000 * 4);
