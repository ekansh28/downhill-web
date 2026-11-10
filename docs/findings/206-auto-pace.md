# 206: the browser caps its own frame rate and resolution when the PC falls behind

Status: in progress

Branch `web/auto-pace` from `web/merge-0713` 244cf4c, started 2026-11-10. Browser build only
(`port/web/www`): two quality-of-life controllers for players on a weak PC (a laptop on its
integrated GPU, finding 201). No gameplay change: the game's step is real time at any rate
(finding 139) and the renderer's scale never changes what the game reads back (the exact GS
answers the Z probe; the native renderer only shows pictures).

## Goal and acceptance

1. Frame cap. The player chose a rate above 60 (PC SETTINGS > Frame Rate: a number, or Monitor).
   When the measured field rate stays well under it, the pacing in `worker.js` holds the highest
   candidate rate the PC does hold (240, 165, 144, 120, 100, 90, 75, 72, then the 59.94 base, never
   less), and lets go again after a sustained spell with room. The game is not told
   (`host_pacing_config` still reports the chosen period; the worker lengthens its own `period`).
2. Resolution. When the game is under the base rate and the graphics worker is the one with no idle
   time, the native renderer's scale (`DHD_SCALE`) goes one level under the player's, is kept only
   if the rate rose, and goes back up after a long calm spell.
3. Neither touches a deterministic run: `run_headless.mjs` has its own host (no `worker.js`), and
   `worker.js` arms the controllers only with `DHD_FPS_WALL=1` (the browser's default; a
   `?env.DHD_FPS_WALL=` run keeps the virtual clock and gets no controller).

Done when `node port/web/check_auto_pace.mjs` prints `auto_pace: ok`, the status message carries
the cap and the automatic scale, and a browser run on a slow machine logs `pacing: capped at ...`
and `resolution: 1x ...` and shows both in the status line.

Out of scope: a PC SETTINGS row for either (see Decisions), the native x64 build (its pacing is
`port/hle/host.c`'s display-period lock), a GPU timestamp measurement.

## What is where

- `port/web/www/auto_pace.js`: `FramePacer` and `ScalePacer`, pure logic, one `sample()` a
  second each. `port/web/check_auto_pace.mjs` runs them through the cases below in node.
- `port/web/www/worker.js`: the status tick (`host_service_gs_vsync`, once a second) measures a
  field's work (the time from the end of one pacing wait to the start of the next), the share of
  fields at which the graphics worker still had packets when the next field was due (its queue's
  `written != consumed`, `WEB_Q_BLOCK2`: how busy that worker is), and feeds both pacers after the
  first 15 seconds (loading, pipeline compiles). The cap is `capHz`: `period = max(asked, 1000 /
  capHz)` at every `host_pacing_config`. The scale goes through `setEnv('DHD_SCALE', ...)`, the
  same path PC SETTINGS > Resolution takes (finding 193: `gs_native_scale_apply` at the next
  vsync); the player's own choice is kept in `userScale` (from `host_putenv`, so a change in the
  menu resets the controller to the new level at once). The status message carries `autoCap`
  (Hz, 0 when none), `autoScale` (the level set here, null when none), `gpuBusy` and `work`.
  `main.js` appends `capped N fields/s` and `auto Nx` to the status line (the menu, backquote).
- Off switches for tests: `?env.DHD_AUTO_PACE=0`, `?env.DHD_AUTO_SCALE=0`.

## The rules (auto_pace.js's constants)

Frame cap: 3 seconds in a row under 88% of the paced rate caps at the highest candidate under 97%
of the slowest of those seconds. A field's work under 75% of a rate's period for 10 seconds in a
row lifts the cap to the highest rate the work has room for (one jump). A cap again within 30
seconds of a rise means the rise did not hold: the wait doubles (10, 20, 40 ... 240 s) and later
rises go one candidate at a time.

Resolution: 4 seconds in a row under 92% of 59.94 with the graphics worker busy at more than 85%
of the fields drops one level, as a trial: 5 seconds to settle (surfaces made over), then the mean
of 3 seconds must be at least 1.25 times the rate before (or reach the base rate), else the level
goes back and no trial comes for 60 seconds (doubling to 600). At the base rate with the graphics
worker busy under half the fields for 45 seconds in a row, one level up; a level that does not
hold doubles that wait.

## Progress

- [x] 2026-11-10: research, the two controllers with the node test, the worker and status wiring,
  one browser run on this machine (below).

## Decisions

- On by default, no setting. A setting would be a row in the Rust table
  (`port/render/settings/src/table.rs`, a regenerated `settings_table.h`, a compiled change and a
  `check.py port`), and both behaviours are bounded by the player's own choices: the cap never
  goes under 60, the scale never over the player's, and both report in the status line and the log.
  The `?env.` switches serve the tests. If players ask, a row is a small follow-up.
- No `requestAnimationFrame`: the worker's pacing is its own timer on `Atomics.waitAsync` (the
  browser's rAF in a worker is tied to the page's display and clamps in a hidden tab), so a cap is
  only a longer `period` in the existing `due = max(due + period, now - 4 * period)` line.
- The GPU measure is the graphics worker's queue, not a GPU timestamp: WebGPU's
  `timestamp-query` is an optional feature (not on every adapter, and the renderer would have to
  resolve and read it back), while the ring's state at the due time is already in shared memory
  and separates "the game is slow" (the ring drained) from "the picture is slow" (packets left).
- The trial-and-verify step on the scale is because a busy graphics worker is not only pixels: on
  this machine the VU1 and GS work per draw stays the same at 1x, so a drop that gains nothing is
  undone instead of costing the player resolution.
- Candidates stop at the 59.94 base: under it the delta-time clock already runs the game at real
  time with longer steps (finding 139), and a lower cap would only add latency.

## Surprises

- The first measure for "GPU behind", the queued bytes as a share of the 8 MiB ring, read 0.000
  at every status tick: a vsync's packets are a few KiB. The share of fields with anything left
  when the next one is due is the usable signal.
- On this machine (shared, headless Edge, Intel), 144 chosen: 16-24 fields/s in the menus with a
  field's work at 41 ms, the graphics worker busy at every sample. The cap went to 59.94 at once
  (`pacing: capped at 59.94 fields/s (this PC holds about 16)`), the scale to 1x, and the trial
  kept 1x on a rise from about 16 to about 19-20 (noise; `SCALE_GAIN` was 1.1 then, 1.25 now so a
  gain inside the noise band is not a pass). The rate never recovered in the run, so the release
  path is covered by the node test only.

## Research

- Unity HDRP's dynamic resolution (docs: "HD Dynamic Resolution" component properties): a GPU
  frame-time average over a window, separate scale-down and scale-up durations as the hysteresis.
  The same shape here, with durations in seconds.
- Dynamic resolution patents (US 9811874, 10573275): per-direction counters, a change only after a
  threshold of consecutive triggers; a frame cap by delaying submission. The counters are
  `low`/`calm` here.
- MDN, `DedicatedWorkerGlobalScope.requestAnimationFrame` and the Chromium intent to ship: rAF in
  a worker needs an owner window and throttles with it; the existing timer pacing was kept.
- web3dsurvey / WebGPU `timestamp-query`: optional feature; not relied on.

## Result

Filled in at the merge.
