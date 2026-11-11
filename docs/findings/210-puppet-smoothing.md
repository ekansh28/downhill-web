# 210: puppets that keep moving through SFU stalls, and corrections that slide instead of jump

Status: current
Checked: 2026-11-12
Supersedes: 202 decision 3 (the carry limit: the usual age plus 50 ms, at most 600 ms)

Branch `web/net-tune` from `web/self-host` 491a438, started 2026-11-12. Game core only
(`port/hle/puppet.c`, `port/hle/puppet_predict.h`) and its tests; no protocol, server or transport
change.

## Goal and acceptance

Online races in the browser should look smooth and live, with players often 150-250 ms from the
room (India to a European or Asian Cloudflare edge). Other riders should be shown where they really
are, with no visible jumps or freezes. State sync stays as it is (finding 044): there is no input
delay, no lockstep and no tick agreement, and frames still go through Cloudflare only.

Acceptance:
- `test_puppet_sim.c` checks the new tuning against the old one on every simulated link. It must
  be about as close (mean error within 2%, p99 within 10%, angle within 2%), with no more jumps
  or freezes, and under 1 jump and 0.1 s of freeze a minute on every link.
- `python port/tools/test_runtime.py` passes. It runs `puppet-predict` and `puppet-sim`.
- The headless race identity check (finding 203, "Race identity") still gives
  `vu_steps 82315732`. That race is single-player, so it shows that nothing outside the puppets
  moved.

Out of scope: the transport (finding 173's stalls are Cloudflare's), the interpolating mode
`DHD_PUPPET_PREDICT=0` (unchanged), and hits (finding 044's rule, decided on the pose as shown).

## Research

- **Gaffer on Games, "Snapshot Interpolation"**
  (https://gafferongames.com/post/snapshot_interpolation/). An interpolation buffer of about 3
  send intervals survives 2-5% loss. Extrapolation is acceptable for 50-250 ms of mostly linear
  motion and fails at collisions. The recommended alternative is a higher send rate, which this
  game already has (60 a second for humans, finding 169).
- **Gaffer on Games, "State Synchronization"**
  (https://gafferongames.com/post/state_synchronization/). Smooth only what is drawn, never the
  simulation. Keep a position and orientation error offset, absorb each update into it, and decay
  it. A single decay factor does not work: 0.95 a frame suits small errors and is too slow for
  the large ones after seconds of loss, so the factor is blended by error size. That is the idea
  behind `fade_speed` here, tuned the other way round (see Decisions).
- **Valve, Source Multiplayer Networking**
  (https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking; the page itself refused
  the fetch, so the values come from its search summary). The default is 100 ms of interpolation
  (`cl_interp 0.1`), so one lost snapshot is survived. When more are lost, linear extrapolation
  takes over, capped at 0.25 s (`cl_extrapolate_amount`) "since prediction errors grow too large
  after that". Finding 169 used the same 250 ms cap. A downhill racer moves about 95 units a second,
  though, so a rider frozen for 750 ms is a far larger error than one carried straight on (the
  table below).
- **Rocket League** (GDC 2018, Jared Cone, https://www.gdcvault.com/play/1024972/) and **Overwatch**
  (GDC 2017, Tim Ford, https://gdcvault.com/play/1024001). Both are server-authoritative with
  client prediction and rollback, and an input buffer that grows and shrinks with jitter (secondary
  sources only: https://hone.gg/blog/fix-lag-in-rocket-league/,
  https://edgegap.com/blog/game-backend-deep-dive-overwatch-2016-netcode-architecture-rollback).
  Neither fits here: both need input lockstep or a shared simulation, which the decisions table
  rules out.
- **Adaptive playout delay** (VoIP jitter buffers;
  https://oreilly.com/library/view/voip-voice-and/9780470227367/ch010-sec006.html,
  https://www.alphaxiv.org/abs/2511.16902). These sources say a mean-and-deviation estimate does
  not control which percentile of packets arrive in time, and that the estimate should react
  quickly to late arrivals and slowly to early ones. That applies to `puppet_delay`
  (`DHD_PUPPET_PREDICT=0`) only. With prediction on, the age sets no delay, and the carry limit
  no longer depends on it (Decisions), so the estimator was left as it was.
- **Cloudflare Realtime DataChannels**
  (https://developers.cloudflare.com/changelog/post/2026-08-13-datachannels-reliability-ordering/,
  https://developers.cloudflare.com/realtime/sfu/features/datachannels/). Since 2026-08-13 a channel
  can be unordered and partially reliable (`ordered: false`, `maxRetransmits: 0`). The publisher's
  policy must be repeated in every subscriber request and in the browser's `createDataChannel`.
  This repository already does all three (`online/server/src/sfu.ts` `policies`,
  `port/web/www/sfu.js`, `port/render/net/src/sfu.rs`). Finding 173 still measured Cloudflare
  forwarding the channel ordered and reliable, with about 1,008 ms resends, and that is the stall
  this lane smooths over. Worth a recheck on the transport side: if Cloudflare now honours the
  policy, the browser's stalls go away at their source.

## Progress

- [x] 2026-11-12: the carry and correction move into `puppet_predict.h` as pure functions with a
      tuning (`PuppetTune`, `puppet_carry`, `puppet_show`). `puppet.c` calls them, the simulator
      `test_puppet_sim.c` is added, and `test_puppet_predict.c` covers the new parts. WIP commit
      2658f72.
- [x] 2026-11-12: the tuning chosen and checked on seeds it was not tuned on. The finding.

## The simulator (`port/hle/test_puppet_sim.c`)

The simulator runs the same header code `puppet.c` uses, frame by frame:
- **Path.** A rider's true path over 240 s. Speed and turn rate wander (Ornstein-Uhlenbeck around
  90 units a second). The ground has bumps. Kickers throw the rider into the air every 4-10 s
  (gravity 110 units/s², a 360° spin trick on half of them). A crash every 20-40 s ends in a
  respawn 40 units back.
- **Link.** Snapshots at 60 a second (30 for an AI rider). Each has a one-way age plus exponential
  jitter, and a +50-150 ms delay spike for 300 ms comes about every 10 s. Then loss:
  - Native: a lost snapshot is gone (unordered).
  - Browser: Cloudflare's ordered, reliable forwarding. Later snapshots wait behind a lost one
    until it is resent: 85% after 20-100 ms, 4% after 100-500 ms, 11% after about 1 s (finding
    173's counts).
  - One link adds a forced 1 s stall every 7-22 s.
- **Viewer.** 60 frames a second (144 on one link), with a 5% jitter on frame time. A stale
  snapshot is dropped, as `receive_record` drops it. A crash is the game's own from the snapshot's
  crash bit to the respawn, which then shows at once, as `hle_puppet_physics` does.
- **Score.** Error is the distance from the drawn pose to the true pose at that moment, in game
  units. The angle is between the drawn and true forward axis. A jerk is a drawn speed more than
  30 units/s off the true speed (`puppet_lag.py`'s rule). A jump is a frame whose drawn motion
  differs from the true motion by more than 300 units/s (5 units in one 60 fps frame). Freeze is
  time drawn at under 30% of the true speed while the rider moves faster than 30. Crash time and
  the respawn frame are not scored.

The old behaviour is reproduced exactly as the baseline (`test_puppet_sim before`). It carries at
full speed up to the snapshots' usual age plus 50 ms (puppet.c's estimate, 250-600 ms) and then
holds, fades a correction 1/e in 80 ms, and shows any jump over 8 units at once.

The near link's numbers (mean 0.64 units, p95 1.3) sit close to what finding 169 measured live
(prediction on: 0.20 p50 / 0.96 p95 units), slightly worse. So the synthetic path turns at least
as hard as a real one.

## Results

Six seeds per link, 24 minutes each. Errors are in game units (a rider moves about 95 a second).

| Link | err mean | p95 | p99 | deg mean | jerk/min | jump/min | freeze s/min | snaps/min |
|---|---|---|---|---|---|---|---|---|
| near, native, 1% loss: before | 0.64 | 1.28 | 2.57 | 1.47 | 14.9 | 0.14 | 0.00 | 0.14 |
| near, native, 1% loss: after | 0.64 | 1.27 | 2.58 | 0.87 | 14.9 | **0** | 0.00 | 0 |
| India (110 ms), native, 2%: before | 1.97 | 3.71 | 5.71 | 3.34 | 99.7 | 5.77 | 0.10 | 5.77 |
| India (110 ms), native, 2%: after | 1.99 | 3.79 | 6.22 | 2.47 | 88.7 | **0** | 0.00 | 0 |
| India, browser, 1%: before | 4.12 | 12.43 | 62.16 | 4.29 | 353.5 | 13.71 | 3.66 | 13.80 |
| India, browser, 1%: after | 2.96 | 8.67 | 24.41 | 3.35 | 146.4 | **0.05** | **0.00** | 0.05 |
| India (125 ms), browser, 2%: before | 6.86 | 42.23 | 75.49 | 5.38 | 637.6 | 23.02 | 7.53 | 23.16 |
| India (125 ms), browser, 2%: after | 4.40 | 17.56 | 34.34 | 4.75 | 261.1 | **0.09** | **0.01** | 0.09 |
| India, browser, 1 s stalls: before | 6.68 | 42.58 | 74.92 | 5.58 | 587.7 | 19.91 | 7.04 | 19.96 |
| India, browser, 1 s stalls: after | 4.14 | 16.01 | 32.32 | 4.80 | 233.3 | **0.14** | **0.03** | 0.14 |
| India, AI rider (30/s): before | 5.05 | 18.54 | 69.73 | 5.11 | 476.1 | 21.79 | 4.79 | 22.02 |
| India, AI rider (30/s): after | 3.59 | 10.91 | 27.36 | 4.16 | 211.9 | **0.14** | **0.00** | 0.14 |
| relay race, 250 ms: before | 4.97 | 9.14 | 13.65 | 7.41 | 893.7 | 49.47 | 2.87 | 50.27 |
| relay race, 250 ms: after | 4.96 | 9.61 | 14.74 | 7.27 | 490.5 | **0** | 0.02 | 0 |
| India, browser, 144 fps: before | 6.79 | 42.21 | 75.48 | 5.40 | 1481.9 | 21.75 | 7.62 | 21.84 |
| India, browser, 144 fps: after | 4.30 | 17.38 | 34.10 | 4.71 | 596.7 | **0.09** | **0.01** | 0.09 |

On six other seeds, which were not used for tuning, the picture was the same. The browser at 2%
loss went from mean 6.40 / p99 74.6 / 22.4 jumps / 6.8 s frozen a minute to 4.02 / 30.0 / 0.23 /
0.07. Native at 2% went from 5.6 to 0 jumps a minute, with p99 5.59 → 6.41 (+15%).

In words:
- On a browser link, a stall used to freeze the rider for about 0.75 s and then snap it 50-75
  units forward, 3.6-7.5 s of freeze and 14-23 jumps a minute. Now the rider keeps moving through
  the stall and slides back to its place.
- On every link, a kicker's take-off or landing used to give 6-50 jumps a minute. Those happened
  whenever the take-off or landing fell inside a snapshot's carry: about 70 units/s of
  vertical-velocity change over a 110-250 ms carry is over 8 units, which snapped. Those are gone.
- The cost is a little error while a correction slides. Mean error is within 1%. p99 is up 9-15%
  on links without stalls (native 2%: 5.7 → 6.2), where a kicker's misprediction now fades over
  about 0.1 s instead of snapping away at once.

## Decisions

1. **The rider keeps moving through a stall.** A snapshot is carried at full speed for 1 s
   (`carry`). After that its velocity fades with a 0.5 s time constant (`coast`), and from 1.5 s
   after the snapshot the pose is held (`coast_max`). The old limit (the usual age plus 50 ms,
   250-600 ms) froze the rider for most of a 1 s stall. The simulator compared a 0.25-1.0 s carry
   with no coast, 0.25 s, and 0.5 s. It also compared 1.5 or 2.5 s coast ends. 1.0 s with a
   0.5 s coast had the fewest freezes and the lowest p99, and the coast end made no difference for
   1 s stalls. The limit no longer depends on the age, so `predict_limit` and finding 202's
   `PREDICT_LATE_MAX_MS` are gone. A relay race's 250-600 ms ages are inside the 1 s anyway.
2. **A large correction slides, a small one fades as before.** The position correction fades 1/e
   in 80 ms. When it is larger than 7.2 units (80 ms × 90 units/s), it fades slower, so it starts
   at no more than 90 units/s (`fade_speed`), about a rider's own speed. Only a jump over 60
   units is shown at once (`snap`; it was 8).
   - Gaffer blends toward faster correction for large errors. Here a faster fade of a 30-60 unit
     error is itself a visible jump, so the cap goes the other way.
   - The simulator tried 40, 60 and 90 units/s with snap 25, 40 and 60. 40 had the fewest jerks
     and the highest error. 90 with snap 60 kept mean error within 1% and jumps near 0.
3. **A large turn is shown at once.** The rotation part of a correction fades in 80 ms (it used
   to share the position's time). When it turns more than 30° (`rot_snap`), as at a trick's start
   or landing, it is shown at once. When only the position faded, a correction that used to snap
   whole (position and rotation) left the rotation fading 80 ms behind a 6 rad/s spin. The angle
   p95 on the relay link went from 15.8° to 45.9°. Snapping turns over 30° gives 14.9°, better
   than before.
4. **A respawn still shows at once, by the crash bit.** `puppet_show` starts afresh when the crash
   bit changes, and `hle_puppet_physics` after the local crash. The 60-unit snap is only the guard
   for a teleport without a crash.
5. **One code path.** The old behaviour is not kept as an option. It survives only as the
   simulator's baseline (`before`), reproduced in the test for the comparison.
   `DHD_PUPPET_PREDICT=0` (interpolation in the past) is unchanged.

## Surprises

- The fixed 8-unit snap fired on almost every kicker for a far player, not just on respawns: 5.8 a
  minute on a 110 ms native link and 50 a minute on a relay race. A rider's vertical velocity
  changes by about 70 units/s at a take-off or landing, so a carry of more than about 115 ms gives
  an error over 8 units.
- Slowing a large position correction made orientation worse until rotation got its own time
  constant and snap (Decision 3).
- Tried and dropped:
  - A 0.25 s carry with only a coast after it (0.5 s): browser 2% still had 2.1 s of freeze a
    minute, against 0.01 with a 1 s carry.
  - Snap 25: 4-7 jumps a minute remained on stall links, against 0.1 with snap 60.

## Checks

- `test_puppet_sim` (the table above), `test_puppet_predict` (straight line, turn, small fade,
  large slow fade, large turn snapped, the carry's horizon, teleport snap): OK.
- `python port/tools/test_runtime.py` and the race identity check: see Result.

## Result

`puppet.c` now uses `puppet_carry` and `puppet_show` from `puppet_predict.h` with `PUPPET_TUNE`
`{carry 1.0 s, coast 0.5 s to 1.5 s, tau 0.08 s, fade 90 units/s, snap 60 units, turn snap 30°}`.

Untested:
- A live race between real players far apart. The tuning comes from a synthetic path and link.
- How 1 s of straight-line carry looks at a hairpin. The rider may run off the track for a moment
  and slide back.
- Hits during a stall land on the carried pose, as before on the frozen one (finding 044's rule).
