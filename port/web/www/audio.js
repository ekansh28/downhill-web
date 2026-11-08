// The game's mixer output (48 kHz stereo 16-bit) from the worker's ring (worker.js host_sound_write):
// header [write, read] as running frame counts (they wrap at 2^32; the index is the count modulo the
// ring), then the interleaved samples. The native output's rules (port/host/sound_out_sdl.c,
// finding 043 round 30), so the browser sounds as the PC does:
// - a cushion of TARGET_MS kept queued; play starts once it is there, and after a run dry it plays
//   silence once and builds it again (one gap, not a crackle of many);
// - the drift between the game's field clock and the audio clock followed by reading up to 0.5%
//   faster or slower (linear interpolation);
// - far too much queued (the game caught up after a stall): skip ahead to the cushion, so the
//   sound never lags the picture by more than SKIP_MS;
// - the game slower than real time (the browser often is: 50-56 fields/s, finding 087): the ring
//   is played at the game's measured speed without changing pitch, by WSOLA (20-ms Hann windows at
//   a 10-ms output hop, each placed where the input best matches the previous one's continuation,
//   searched +-5 ms), instead of running dry every few fields.
const RATE = 48000, PER_MS = 48, TARGET_MS = 80, SKIP_MS = 120, RATE_RANGE = 0.005;
const HOP = 480, SEEK = 240, FIFO = 8192;
class Ring extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sab = options.processorOptions.ring;
    this.head = new Int32Array(sab, 0, 2); this.data = new Int16Array(sab, 8); this.cap = (sab.byteLength - 8) / 4;
    this.fifo = new Float32Array(FIFO * 2); this.fw = 0; this.fr = 0;  // stretcher -> output, running counts
    this.st = { on: false, ref: 0, where: 0, rise: new Float32Array(HOP), tail: new Float32Array(HOP * 2), want: new Float32Array(HOP / 2) };
    for (let i = 0; i < HOP; i++) { const w = Math.sin(Math.PI / 2 * (i + 0.5) / HOP); this.st.rise[i] = w * w; }
    this.target = TARGET_MS * PER_MS; this.running = false; this.phase = 0; this.tempo = 1; this.ratio = 1;
    this.speed = 1; this.speedAt = currentTime; this.speedWrite = Atomics.load(this.head, 0);
    this.read = Atomics.load(this.head, 1); this.end = this.read;  // this side's running counts (plain numbers)
  }
  at(n) { return ((n >>> 0) % this.cap) * 2; }
  mono(n) { const i = this.at(n); return this.data[i] + this.data[i + 1]; }
  put(l, r) { const i = (this.fw % FIFO) * 2; this.fifo[i] = l; this.fifo[i + 1] = r; this.fw++; }
  leave() { if (this.st.on) { this.read = this.st.ref; this.st.on = false; } }
  seek(lo, hi, ref) {  // normalized cross-correlation on the mono sum, every 2nd sample, then +-1
    const want = this.st.want, half = HOP / 2;
    for (let i = 0; i < half; i++) want[i] = this.mono(ref + 2 * i);
    let best = lo, bestScore = -Infinity;
    for (let pass = 0; pass < 2; pass++) {
      const from = Math.max(lo, pass ? best - 1 : lo), to = Math.min(hi, pass ? best + 1 : hi), step = pass ? 1 : 2;
      for (let a = from; a <= to; a += step) {
        let dot = 0, energy = 1;
        for (let i = 0; i < half; i++) { const x = this.mono(a + 2 * i); dot += x * want[i]; energy += x * x; }
        const score = dot / Math.sqrt(energy);
        if (score > bestScore) { bestScore = score; best = a; }
      }
    }
    return best;
  }
  fill(want, tempo) {  // the fifo up to `want` frames, copied (tempo 1) or stretched
    const st = this.st, d = this.data;
    if (tempo >= 1) this.leave();
    else if (!st.on) {
      st.on = true; st.ref = this.read; st.where = this.read - HOP;
      for (let i = 0; i < HOP; i++) { const f = this.at(this.read + i), fall = 1 - st.rise[i]; st.tail[i * 2] = d[f] * fall; st.tail[i * 2 + 1] = d[f + 1] * fall; }
    }
    while (this.fw - this.fr < want && this.fw - this.fr <= FIFO - HOP) {
      if (!st.on) {
        if (this.read >= this.end) return;
        const f = this.at(this.read); this.put(d[f], d[f + 1]); this.read++;
        continue;
      }
      const q = Math.floor(st.where + HOP * tempo);
      const lo = Math.max(q - SEEK, this.read), hi = Math.min(q + SEEK, this.end - 2 * HOP);
      if (hi < lo) return;
      const a = this.seek(lo, hi, st.ref);
      for (let i = 0; i < HOP; i++) {
        const f = this.at(a + i), g = this.at(a + HOP + i), rise = st.rise[i], fall = 1 - rise;
        this.put(st.tail[i * 2] + d[f] * rise, st.tail[i * 2 + 1] + d[f + 1] * rise);
        st.tail[i * 2] = d[g] * fall; st.tail[i * 2 + 1] = d[g + 1] * fall;
      }
      st.where += HOP * tempo; st.ref = a + HOP;
      this.read = Math.min(Math.floor(st.where), a);
    }
  }
  process(_inputs, outputs) {
    const [left, right] = outputs[0], need = left.length, h = this.head;
    const w = Atomics.load(h, 0);
    this.end = this.read + ((w - (this.read | 0)) | 0);  // wrap-safe: relative to read
    { // the game's sound rate against real time, smoothed over ~0.5 s
      const dt = currentTime - this.speedAt;
      if (dt >= 0.05) {
        const inst = ((w - this.speedWrite) | 0) / (dt * RATE), a = Math.min(1, dt / 0.5);
        if (this.running) this.speed += a * (Math.min(1.5, inst) - this.speed);
        this.speedWrite = w; this.speedAt = currentTime;
      }
    }
    const target = this.target;
    let level = (this.end - this.read) + (this.fw - this.fr);
    if (level > target + SKIP_MS * PER_MS) {  // caught up after a stall: skip to the cushion
      this.leave(); this.tempo = 1;
      level = (this.end - this.read) + (this.fw - this.fr);
      this.read += Math.max(0, Math.min(level - target, this.end - this.read));
      level = target;
    }
    let made = 0;
    if (!this.running && level >= target) this.running = true;
    if (this.running) {
      const fill = (level - target) / target;
      let tempo = 1;
      const slow = this.speed < 0.97 || level < target * 3 / 4;
      if (this.tempo < 1 ? !(this.speed > 0.99 && level >= target) : slow)
        tempo = Math.max(0.5, Math.min(0.999, this.speed * (1 + 0.5 * fill)));
      this.tempo = tempo;
      const error = tempo < 1 ? 0 : fill * 0.01;
      this.ratio = 1 + Math.max(-RATE_RANGE, Math.min(RATE_RANGE, error));
      this.fill(need + 2, tempo);
      let f = this.phase, r = this.fr;
      for (; made < need; made++) {  // the fifo resampled at ratio (linear)
        if (this.fw - r < 2) break;
        const a = (r % FIFO) * 2, b = ((r + 1) % FIFO) * 2;
        left[made] = (this.fifo[a] + (this.fifo[b] - this.fifo[a]) * f) / 32768;
        right[made] = (this.fifo[a + 1] + (this.fifo[b + 1] - this.fifo[a + 1]) * f) / 32768;
        f += this.ratio;
        while (f >= 1) { f -= 1; r++; }
      }
      this.phase = f; this.fr = r;
      if (made < need) { this.running = false; this.leave(); this.tempo = 1; }  // ran dry: one gap, then the cushion again
    }
    for (let i = made; i < need; i++) left[i] = right[i] = 0;
    Atomics.store(h, 1, this.read | 0);
    return true;
  }
}
registerProcessor('dhd-ring', Ring);

// Voice chat's microphone (main.js, finding 131): its first channel, 48 kHz (the context's rate),
// into the net worker's ring as 16-bit samples: header [write, read] in samples, then the samples. A
// full ring drops what doesn't fit (the net worker reads every 10 ms).
class Mic extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sab = options.processorOptions.ring;
    this.head = new Int32Array(sab, 0, 2); this.data = new Int16Array(sab, 8); this.cap = (sab.byteLength - 8) / 2;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const h = this.head, cap = this.cap, r = Atomics.load(h, 1);
    let w = Atomics.load(h, 0);
    for (let i = 0; i < input.length; i++) {
      if ((w + 1) % cap === r) break;
      const v = Math.max(-1, Math.min(1, input[i]));
      this.data[w] = v < 0 ? v * 32768 : v * 32767; w = (w + 1) % cap;
    }
    Atomics.store(h, 0, w);
    return true;
  }
}
registerProcessor('dhd-mic', Mic);

// Voice chat's others (finding 144): the net worker (net_worker.js) mixes their voices, placed and
// panned as the game asks, into this ring 50 ms ahead of what is played: header [write, read, runs
// dry, -] as running frame counts, then 48 kHz stereo 16-bit samples (net_ring.js). Played as it
// comes, in real time, beside the game's sound and never through the game worker; after a run dry
// (the net worker late) it waits for START_MS before playing again, one gap rather than a crackle.
const START_MS = 20;
class Voice extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const sab = options.processorOptions.ring;
    this.head = new Int32Array(sab, 0, 4); this.data = new Int16Array(sab, 16); this.frames = this.data.length / 2;
    this.running = false;
  }
  process(_inputs, outputs) {
    const [left, right] = outputs[0], h = this.head, need = left.length;
    const w = Atomics.load(h, 0), r = Atomics.load(h, 1), have = (w - r) | 0;
    if (!this.running && have >= START_MS * PER_MS) this.running = true;
    let made = 0;
    if (this.running) {
      for (; made < need && made < have; made++) {
        const at = (((r + made) >>> 0) % this.frames) * 2;
        left[made] = this.data[at] / 32768; right[made] = this.data[at + 1] / 32768;
      }
      Atomics.store(h, 1, (r + made) | 0);
      if (made < need) { this.running = false; Atomics.add(h, 2, 1); }
    }
    for (let i = made; i < need; i++) left[i] = right[i] = 0;
    return true;
  }
}
registerProcessor('dhd-voice', Voice);
