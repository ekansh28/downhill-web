// Automatic pacing for the browser build (finding 206): two small controllers that worker.js feeds
// once a second from its status tick. Pure logic, no browser calls: check_auto_pace.mjs runs it in
// node.
//
// FramePacer: the player chose a frame rate above 60 (PC SETTINGS > Frame Rate). A PC that cannot
// hold it shows uneven fields; capped at a rate it does hold, the fields are even again and the
// GPU gets room. The game is not told: its step is the real time since the last field (finding
// 139), so it stays real time at any rate from 59.94 up. The cap comes after a few seconds below
// the rate, never under the 59.94 base, and goes when the work of a field has room for more.
//
// ScalePacer: the renderer's resolution scale. When the game stays under the base rate while the
// graphics worker has no idle time, it tries one level less, keeps it only if the rate rose, and
// tries the player's level again after a long calm spell.
//
// Both wait twice as long after a step up that did not hold.

export const BASE_HZ = 59.94;
export const RATE_CANDIDATES = [240, 165, 144, 120, 100, 90, 75, 72];   // above BASE_HZ, descending

const CAP_SHORT = 0.88;           // fields/s under this share of the paced rate: short
const CAP_DROP_SECONDS = 3;       // short this many samples in a row: cap
const CAP_HOLD = 0.97;            // the cap: the highest candidate under this share of the slowest short sample
const CAP_RISE_SECONDS = 10;      // room this many samples in a row: the cap rises
const CAP_RISE_WORK = 0.75;       // room for a rate: a field's work under this share of its period
const CAP_FAILED_SECONDS = 30;    // capped again this soon after a rise: the rise did not hold
const CAP_WAIT_MAX = 240;

const SCALE_SHORT = 0.92;         // fields/s under this share of BASE_HZ: short
const SCALE_BUSY = 0.85;          // the graphics worker busy this share of the time: it is what is behind
const SCALE_DROP_SECONDS = 4;     // short and busy this many samples in a row: one level less
const SCALE_SETTLE_SECONDS = 5;   // after a change the renderer makes its surfaces over: not judged
const SCALE_VERIFY_SECONDS = 3;   // then the rate over this many samples says whether the level helped
const SCALE_GAIN = 1.25;          // helped: the rate rose by this factor at least (or reached the base); fewer pixels should give more
const SCALE_RETRY_SECONDS = 60;   // a level that did not help: no other try for this long (doubles)
const SCALE_RISE_SECONDS = 45;    // calm this many samples in a row: one level more (doubles after one that did not hold)
const SCALE_RISE_BUSY = 0.5;      // calm: at the base rate with the graphics worker under this share
const SCALE_WAIT_MAX = 600;

export class FramePacer {
  constructor() { this.reset(0); }
  reset(chosenHz) {
    this.chosen = chosenHz; this.cap = null;          // cap: null (the chosen rate) or a candidate under it
    this.low = 0; this.slowest = Infinity;            // the short streak and its slowest sample
    this.calm = 0; this.work = 0;                     // the streak with room, and its longest field work (ms)
    this.wait = CAP_RISE_SECONDS; this.careful = false;   // careful: after a rise that did not hold, one candidate at a time
    this.tick = 0; this.raisedAt = -Infinity;
  }
  // The rate the pacing holds (Hz).
  get effective() { return this.cap ?? this.chosen; }
  // One sample a second: fields/s, a field's mean work in ms (all of it but the pacing wait) and the
  // rate the game asked for. Returns the rate to hold.
  sample(fps, workMs, chosenHz) {
    if (Math.abs(chosenHz - this.chosen) > 0.01) this.reset(chosenHz);
    this.tick++;
    if (this.chosen <= BASE_HZ + 0.5) return this.chosen;   // nothing under it to cap at
    const rate = this.effective, under = [...RATE_CANDIDATES.filter(c => c < this.chosen), BASE_HZ];
    if (fps < CAP_SHORT * rate) { this.low++; this.slowest = Math.min(this.slowest, fps); this.calm = 0; }
    else { this.low = 0; this.slowest = Infinity; }
    if (this.low >= CAP_DROP_SECONDS) {
      if (rate > BASE_HZ) {
        this.cap = under.find(c => c < rate && c <= this.slowest * CAP_HOLD) ?? BASE_HZ;
        if (this.tick - this.raisedAt <= CAP_FAILED_SECONDS) { this.wait = Math.min(this.wait * 2, CAP_WAIT_MAX); this.careful = true; }
        this.raisedAt = -Infinity;
      }
      this.low = 0; this.slowest = Infinity;
      return this.effective;
    }
    if (this.cap === null || this.low) return rate;
    const above = [this.chosen, ...under.filter(c => c > this.cap)];   // descending; the last is the next one up
    const room = hz => this.work < CAP_RISE_WORK * 1000 / hz;
    this.work = Math.max(this.calm ? this.work : 0, workMs);
    if (!room(above.at(-1))) { this.calm = 0; return rate; }
    if (++this.calm >= this.wait) {
      const to = this.careful ? above.at(-1) : above.find(room);
      this.cap = to === this.chosen ? null : to;
      this.calm = 0; this.raisedAt = this.tick;
    }
    return this.effective;
  }
}

export class ScalePacer {
  constructor() { this.reset(0); }
  reset(chosen) {
    this.chosen = chosen; this.level = chosen;
    this.low = 0; this.lowSum = 0; this.calm = 0;
    this.settle = 0; this.trial = null;               // trial: a lower level being judged { from, before, n, sum }
    this.blocked = 0; this.retry = SCALE_RETRY_SECONDS;
    this.wait = SCALE_RISE_SECONDS; this.tick = 0; this.raisedAt = -Infinity;
  }
  // One sample a second: fields/s, the share of the second the graphics worker was busy (0 to 1; null
  // where it is not measured) and the player's scale (a whole number; anything else leaves the scale
  // alone). Returns the scale to draw at.
  sample(fps, busy, chosen) {
    if (!Object.is(chosen, this.chosen)) this.reset(chosen);
    this.tick++;
    if (!(chosen > 1) || busy === null) return this.level;
    if (this.settle > 0) { this.settle--; return this.level; }
    if (this.blocked > 0) this.blocked--;
    if (this.trial) {
      const t = this.trial; t.sum += fps;
      if (++t.n < SCALE_VERIFY_SECONDS) return this.level;
      const now = t.sum / t.n;
      this.trial = null;
      if (now < t.before * SCALE_GAIN && now < SCALE_SHORT * BASE_HZ) {   // it did not help: the GPU's pixels are not what is slow
        this.level = t.from; this.settle = SCALE_SETTLE_SECONDS;
        this.blocked = this.retry; this.retry = Math.min(this.retry * 2, SCALE_WAIT_MAX);
      }
      return this.level;
    }
    const short = fps < SCALE_SHORT * BASE_HZ;
    if (short && busy > SCALE_BUSY) { this.low++; this.lowSum += fps; } else this.low = this.lowSum = 0;
    if (this.low >= SCALE_DROP_SECONDS && this.level > 1 && !this.blocked) {
      this.trial = { from: this.level, before: this.lowSum / this.low, n: 0, sum: 0 };
      this.level--; this.settle = SCALE_SETTLE_SECONDS;
      if (this.tick - this.raisedAt <= 2 * SCALE_RISE_SECONDS) this.wait = Math.min(this.wait * 2, SCALE_WAIT_MAX);
      this.low = this.lowSum = this.calm = 0; this.raisedAt = -Infinity;
      return this.level;
    }
    this.calm = this.level < chosen && !short && busy < SCALE_RISE_BUSY ? this.calm + 1 : 0;
    if (this.calm >= this.wait) { this.level++; this.calm = 0; this.settle = SCALE_SETTLE_SECONDS; this.raisedAt = this.tick; }
    return this.level;
  }
}
