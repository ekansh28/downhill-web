# 211: the browser's worker queues: batching and shorter spins tried, slower; a lazy retire kept

Status: in progress

Branch `web/gs-hygiene` from `web/self-host` 491a438, 2026-11-12. Browser only
(`port/web/web_queue.c`, `port/web/www`). The lane is finished; it becomes `current` at the
merge.

## Goal and acceptance

The goal was smoother frames in the threaded browser build: fewer slow frames, and less CPU
taken from the VU worker, which limits the race (findings 197, 201). A research plan
(2026-11-10) listed three items:

1. `web_queue.c`. The GS worker stores the second ring's `consumed` after every packet. The VU
   worker stores `written` after every XGKICK and wakes the GS worker if it sleeps. Both empty
   waits spin 32768 steps before they sleep: the GS worker spent 41% of its time there and the VU
   worker 10% (finding 197).
2. `www/worker.js` and `www/graphics.js`: allocations made every field (the sound copy, the
   status numbers, `pad()`), and counting `host_fiber_switch` calls before changing anything there.
3. The Rust renderer: the Z probe's 8-9 buffer writes a field, and 353-367 `setBindGroup(1)`
   calls a field.

Acceptance:
- The headless race (finding 203, "Race identity") gives `vu_steps = vu_blocks = 82315732` and
  `vu_native 4545648`. With `--trace`, `trace_columns.py` passes in every column, against the
  base build.
- Browser races are run before and after, alternating, with worker profiles (below).

## What was tried

**A: batched publication and adaptive spins** (71c1b46):
- The VU worker publishes the second ring in batches: 16 KB, or at once for a mark, a vsync, an
  environment line, before waiting for room and before going idle. This is PCSX2 MTGS's rule:
  it stores `WritePos` per packet but wakes its GS thread only past 0x2000 quadwords, at a vsync
  or a wait.
- Both consumers use the native ring's adaptive empty-wait spin (`graphics_queue.c` `idle_wait`,
  finding 069). A spin that sees data leaves 2x the steps it took plus 512, up to 32768; a spin
  that runs out halves the budget, down to 512.
- The VU worker keeps the last `consumed` it read and reads it again only when that room is too
  small. The GS worker retires lazily (as in B).

The state was identical (below). The GS worker's spin went from 49-51% of its samples to
0.5-0.7%, and its idle time from 19% to 66-70%.

But the race got slower: 4 of 5 pairs, and the slowest 10% in every pair but one (table). The GS
worker now sleeps between batches and wakes through its event loop (`Atomics.waitAsync`). The
core's waits sit on the GS worker: a waited call or `graphics_wait` ends only when the GS worker
retires the VU worker's mark. So each wake-up, and the up to 16 KB queued ahead of the mark, adds
to the time the core waits. The spin the plan wanted gone is what keeps that wait short. Even on
8 logical CPUs (the brief's 4-core laptop with hyperthreads; see Method) the spin cost nothing
measurable.

**B: the GS worker's lazy retire only** (a247f44, the code on this branch). The GS worker stores
the second ring's `consumed` in these cases:
- when the VU worker waits for room (`waiting`);
- every 64 KB;
- before it spins on an empty ring;
- before it returns, because `worker.js`'s `gsPending` reads `written == consumed` as idle.

It no longer stores it after every packet. Nothing else changed. The first ring's `consumed` (the
core's) is still stored at each `WQ_MARK`. `vu.wasm` is byte-identical to the base build's; only
`graphics.wasm` differs. Gain: none measurable (table). It is kept as plain hygiene: it removes
a locked store and a cache-line handoff per packet between the two workers.

**JS** (in both A and B runs, no separate measurement):
- `host_sound_write` copies the frames into the sound ring with `set()` in whole runs. The old
  code did a `.slice()` plus a `%` per frame. A run ends at the ring's end or where the 32-bit
  count wraps, so every frame lands where audio.js reads it. A node check against the old loop
  (20,000 random heads and counts, wraps included) found 0 differences.
- `graphics.js` makes its control-block views and the stats index table once, not at each vsync.
- `worker.js` makes its views and the stats closure once. `pad()` loops with no array or closure
  per call.

**`host_fiber_switch`**: the headless race makes 3396 switches in 4300 fields, under one a field.
Nothing to gain there; not touched.

**Item 3: nothing to do.**
- `setBindGroup(1)` is already skipped when the group is unchanged (`Pass::set_groups`, finding
  087 BS4). Each texture already keeps its bind groups (`Tex::groups`; a replacement has one per
  sampler). The 353-367 calls a field are real texture changes; fewer would need textures indexed
  in the shader.
- The Z probe's writes come one per buffer from the C front end (`gpu_exact.inc`,
  `dhdr_exact_write`). One write would need a staging buffer plus copies, or an ABI change on the
  exact path, which is game state. It would save about eight calls a field on a worker that is
  under half busy.

## Method

- Identity: finding 203's command (`run_headless.mjs`, 4300 fields, race_compare's NAV and pad,
  seed 80728). Each build ran its own `--module`/`--graphics` set from a copy outside the tree.
- Browser: `check_browser.mjs` in headless Edge, with:
  - `--query` with the same NAV, pad and seed, plus `DHD_FPS=144` (unpaced) and `DHD_SCALE=2`;
  - `DHD_AUTO_PACE=0` and `DHD_AUTO_SCALE=0`, so the pacers change nothing;
  - a fresh profile each run, run to field 4700;
  - `--profile 3700 12 --profile-worker graphics.js` (or `vu.js`).

  The race numbers are the page's one-a-second fps samples from field 3600 on (20-30 samples).
  "Slowest 10%" is the mean of the lowest tenth of those samples. Each build is a site tree of
  its own (`port/web` plus `build/web`), served alternately.
- 8-CPU runs: a PowerShell wrapper sets its own affinity to 0xFF (8 logical CPUs) and starts the
  run, and Edge and its workers inherit it (checked: affinity 255).
- The PC (16 logical CPUs, NVIDIA) was shared with other agents' builds: 74% load was seen during
  one run. The same build varies by 8-13 fps between runs, more than any difference measured
  here.

## Numbers

Identity, every build:

| | vu_steps | vu_blocks | vu_native | trace (`--trace`, 4300 rows) |
|---|---|---|---|---|
| base | 82315732 | 82315732 | 4545648 | reference |
| A | 82315732 | 82315732 | 4545648 | PASS, all 13 columns identical, `.ptrs.tsv` byte-identical |
| B | 82315732 | 82315732 | 4545648 | PASS, all 13 columns identical, `.ptrs.tsv` byte-identical |

Headless speed: base 51.0 against A 50.1 fields/s untraced. Traced: base 16.6, A 4.7, B 15.8.
A's traced run overlapped another agent's 30-minute compile; untraced, run back to back, the
two are level.

Browser race, mean fps / slowest 10% (all runs, in the order run):

| run | profile | base | A | B |
|---|---|---|---|---|
| 1 | GS worker | 57.0 / 51.5 | 48.5 / 40.3 | |
| 1 | VU worker | 55.9 / 48.8 | 53.4 / 46.4 | |
| 2 | GS worker | 54.7 / 48.8 | 48.7 / 42.3 | |
| 2 | VU worker | 54.3 / 45.3 | crashed at field 1952 (Surprises) | |
| 3 | GS worker | 49.0 / 41.8 | | 54.5 / 40.3 |
| 4 | VU worker | 50.1 / 42.7 | | 52.1 / 39.9 |
| 5 | GS worker | 53.0 / 40.8 | | 53.3 / 39.6 |
| 8 CPUs, 1 | GS worker | 50.9 / 45.4 | 38.4 / 30.4 | 46.9 / 34.2 |
| 8 CPUs, 2 | GS worker | 44.4 / 35.7 | 51.3 / 37.2 | 47.8 / 40.7 |

Means over the runs that ran alongside each other:
- A against base, 5 pairs: 48.1 / 39.3 against 52.6 / 46.0.
- B against base, 5 pairs: 50.9 / 38.9 against 49.5 / 41.3.

Profiles, self time:
- GS worker, `web_q_run`: base 44.6-50.8%, B 46.6-48.0%, A 0.5-0.7%. Idle: base 19-24%, B
  21-22%, A 66-70%.
- VU worker: `run_micro` 63.5% in both builds; `web_vq_run` 9.4-9.6% in base, 8.8% in A. This
  share holds both the spin and the blocking `memory.atomic.wait32`, so it cannot tell them apart.

## Decisions

- A is not kept. It was slower in 4 of 5 pairs, and nothing measured shows a gain.
- B is kept. It is exact and small, and it removes per-packet cross-worker traffic, but it gave
  nothing measurable.
- The first ring (core to VU worker) keeps publishing and waking per packet: the VU worker is the
  bottleneck, and any delay there is time lost.

## Surprises

- A's second VU-profile run stopped at field 1952. The renderer panicked in
  `dhdr_native_zread_start`: wgpu's "Buffer is already mapped" assertion (`left: 0..3600`). The
  cause is in `port/render/src/native/zread.rs`, the native Z probe's map path. `zread_take`
  frees a finished slot but calls `unmap()` only when the map succeeded. A map that fails leaves
  wgpu's map context set (only `unmap()` resets it), so the slot's next `map_async` panics. Some
  map in that run failed. Why it failed was not found, nor whether A's changed event-loop timing
  made it more likely (base: 0 of 12 runs, A: 1 of 6). The renderer was not changed here. A fix
  would reset the map context on a failed map too (in the browser, `unmap()` on an unmapped
  buffer is a no-op; check wgpu-core natively first) and needs the renderer's own checks.
- Any change to `web_queue.c` outside its GS-only branch changes the cache key of the whole
  `vu.wasm` module (objcache's "whole modules"). `vu0_interp.c` with the VU1 AOT blocks then
  compiles again: 30-35 minutes of one core on this PC. B touches only the GS branch, so
  `vu.wasm` came from the cache.

## Result

Kept on the branch: the GS worker's lazy retire (`web_queue.c`, GS side only) and the JS
allocation clean-ups. The race state is identical (counters and every trace column). Neither
gave a measurable change in browser fps or slow frames on this shared PC. Tried and dropped:
batched second-ring publication and adaptive spins (slower), and the renderer items (already done,
or not worth the risk). The browser race is still limited by the VU worker's own work
(`run_micro`, findings 197, 090 OP3), not by queue overhead.

Left: the native Z probe's failed-map path (Surprises). Not checked: a real 4-core laptop (the
8-CPU affinity runs stand in for it), and a display-attached browser.
