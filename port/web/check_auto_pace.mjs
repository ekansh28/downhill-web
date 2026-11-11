// Unit test for www/auto_pace.js (finding 206): the frame cap and the resolution scale step down
// and up as designed, hold still on steady input and wait longer after a step up that did not hold.
//   node port/web/check_auto_pace.mjs
import assert from 'node:assert/strict';
import { FramePacer, ScalePacer, BASE_HZ } from './www/auto_pace.js';

// A PC whose field takes 1000/hold ms of work: paced at r it shows min(r, hold) fields/s.
const run = (p, hold, chosen, seconds) => {
  let last;
  for (let i = 0; i < seconds; i++) last = p.sample(Math.min(p.effective || chosen, hold), 1000 / hold, chosen);
  return last;
};
// The seconds at which the paced rate changes over a run, with the new rate.
const changes = (p, hold, chosen, seconds) => {
  const out = [];
  for (let t = 0, was = p.effective; t < seconds; t++) { const now = run(p, hold, chosen, 1); if (now !== was) out.push([t, was = now]); }
  return out;
};

{ // holds 80 of the 144 chosen: capped at 75 after three seconds, in one step, and it stays
  const p = new FramePacer(); p.sample(144, 3, 144);
  assert.deepEqual(changes(p, 80, 144, 120), [[2, 75]]);
}
{ // a slow PC (holds 45): the cap is the 59.94 base and never less
  const p = new FramePacer(); p.sample(144, 3, 144);
  assert.deepEqual(changes(p, 45, 144, 120), [[2, BASE_HZ]]);
}
{ // a three-second dip on a fast PC (a loading screen): capped, then back to the chosen rate in one step
  const p = new FramePacer(); p.sample(144, 3, 144); run(p, 40, 144, 3);
  assert.equal(p.effective, BASE_HZ);
  assert.deepEqual(changes(p, 400, 144, 60), [[9, 144]]);
}
{ // room for some more only: holds 110 now, so 90 (work 9.1 ms is under 75% of 90's period, not of 100's)
  const p = new FramePacer(); p.sample(144, 3, 144); run(p, 62, 144, 3);
  assert.equal(p.effective, BASE_HZ);
  assert.deepEqual(changes(p, 110, 144, 120), [[9, 75]]);
  assert.deepEqual(changes(p, 125, 144, 120), [[9, 90]]);
}
{ // a rise that does not hold (the work looked short, the rate was not there: above 75 this PC shows
  // 70): capped again, and from then on one candidate at a time, each wait twice the last
  const p = new FramePacer(); p.sample(144, 3, 144); run(p, 80, 144, 3);
  const rises = [];
  for (let t = 0; t < 900; t++) {
    const was = p.effective;
    p.sample(Math.min(was, was > 75 ? 70 : 80), 5, 144);
    if (p.effective > was) rises.push([t, p.effective]);
  }
  assert.deepEqual(rises.slice(0, 7).map(r => r[1]), [144, 72, 75, 90, 72, 75, 90], 'one jump, then careful steps');
  const gaps = rises.slice(1).map((r, i) => r[0] - rises[i][0]);
  assert.deepEqual([gaps[1], gaps[4]], [20, 40], `waits double: ${gaps}`);
}
{ // 60 chosen: nothing to do; a new chosen rate starts over
  const p = new FramePacer();
  assert.equal(run(p, 20, BASE_HZ, 30), BASE_HZ);
  p.sample(144, 3, 144); run(p, 80, 144, 3); assert.equal(p.effective, 75);
  assert.equal(p.sample(100, 5, 120), 120);
}
{ // two slow seconds do not cap
  const p = new FramePacer(); p.sample(144, 3, 144); p.sample(60, 16, 144); p.sample(60, 16, 144); p.sample(144, 3, 144);
  assert.equal(p.effective, 144);
}

// The scale over a run: seconds at which it changes, with the new level. fpsAt(level) is what the PC shows.
const scaleChanges = (p, fpsAt, busyAt, chosen, seconds) => {
  const out = [];
  for (let t = 0, was = p.level; t < seconds; t++) { const now = p.sample(fpsAt(p.level), busyAt(p.level), chosen); if (now !== was) out.push([t, was = now]); }
  return out;
};
const started = chosen => { const p = new ScalePacer(); p.sample(60, 0.3, chosen); return p; };   // running at the player's scale
{ // the GPU is behind at 2x (45 fields/s, the graphics worker never idle) and not at 1x: 1x after 4 s, kept
  const p = started(2);
  assert.deepEqual(scaleChanges(p, l => l === 2 ? 45 : 59.9, l => l === 2 ? 1 : 0.7, 2, 200), [[3, 1]]);
}
{ // the graphics worker is busy but the pixels are not why (the rate is the same at 1x): back to 2x
  // after the trial, and the next try waits (60 s, then 120 s)
  const p = started(2);
  const c = scaleChanges(p, () => 45, () => 1, 2, 330);
  assert.deepEqual(c.map(x => x[1]), [1, 2, 1, 2, 1, 2]);
  assert.equal(c[1][0] - c[0][0], 8, 'five seconds to settle, three to judge');
  assert.ok(c[2][0] - c[1][0] >= 60 && c[4][0] - c[3][0] >= 120, `tries spread out: ${c.map(x => x[0])}`);
}
{ // slow with the graphics worker idle (the game's own work): the scale stays; so do 1x, "Match window"
  // (not a number) and a build without the measurement
  assert.deepEqual(scaleChanges(started(2), () => 45, () => 0.4, 2, 120), []);
  assert.deepEqual(scaleChanges(started(1), () => 30, () => 1, 1, 60), []);
  const w = new ScalePacer(); for (let i = 0; i < 60; i++) assert.ok(Number.isNaN(w.sample(30, 1, NaN)));
  assert.deepEqual(scaleChanges(started(4), () => 30, () => null, 4, 60), []);
}
{ // down two levels (40 fields/s at 3x, 52 at 2x, the base at 1x), calm for 45 s: one level up; it does not hold: down again, the
  // next try after 90 s
  const p = started(3);
  let fast = false;   // the scene: heavy (only 1x holds the base rate), then light at 1x only
  const at = l => l === 1 ? 59.9 : l === 2 ? 52 : 40;
  const c = scaleChanges(p, at, l => l === 1 ? (fast ? 0.3 : 0.7) : 1, 3, 40);
  assert.deepEqual(c.map(x => x[1]), [2, 1]);
  fast = true;
  const d = scaleChanges(p, at, l => l === 1 ? 0.3 : 1, 3, 400);
  assert.deepEqual(d.slice(0, 4).map(x => x[1]), [2, 1, 2, 1]);
  assert.ok(d[0][0] >= 44 && d[2][0] - d[1][0] >= 90, `second rise waits twice as long: ${d.map(x => x[0])}`);
}
{ // the player changes the scale: theirs at once
  const p = started(2);
  scaleChanges(p, l => l === 2 ? 45 : 59.9, l => l === 2 ? 1 : 0.7, 2, 20);
  assert.equal(p.level, 1); assert.equal(p.sample(60, 0.2, 4), 4);
}
console.log('auto_pace: ok');
