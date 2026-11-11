# 203: VIF1 UNPACK: the SIMD path for WL = CL too, a branchless mask setup

Status: current
Checked: 2026-11-10

Branch `web/vif-unpack` from `web/self-host` fec667e, 2026-11-10. `port/hle/vif.c`. It runs in the
x64 exe and the browser's VU worker (`vu.wasm`, `build_graphics.py`).

## Goal and acceptance

Make VIF1 UNPACK cheaper (finding 090 OP3 (b): about 12% of the vu thread; in the browser
`vif_feed` is 6.7% of the VU worker's profile, finding 197) and keep the output the same. Done
when:
- `python port/tools/test_runtime.py` passes. The VIF test compares the fast paths with the
  generic per-vector path (`vif_unpack_reference`) over the whole 16 KB data memory.
- A headless browser race (the command in "Method") gives the same `vu_steps 82315732`,
  `vu_blocks 82315732` and `vu_native 4545648` as the base build, and the same state trace in
  every column (`trace_columns.py`).
- It is not slower.

Out of scope: the filling path (WL > CL; a race never sends it), modes 1 and 2, VIF0.

## What was already there

Finding 090 VU1R (item 4) had done OP3's first item already. `stream_wl1` took WL 1 at mode 0
with SSE2 decoders (S-8, V2-16, V4-8, V4-32, V4-5) and a per-lane blend for masked commands. So
this lane did what was still left from OP3's list:
- The CL 4 WL 4 forms (V3-32 USN, V3-8, V4-32, S-32) still went through `stream_form`, one
  field at a time through a `switch`. They were about 18% of the unpack time.
- Each command set up the masked blend in a 4-step loop with branches, through arrays in memory.
  S-8 masked averages 2.2 vectors a command, so this setup was a large part of its cost.

## Change

- `stream_wl1` is now `stream_simd(..., stride)`, and `wl1_fields` is now `simd_fields`.
  `unpack_stream` uses it at mode 0 in two cases:
  - WL 1 (any CL, masked or not), with stride CL, as before.
  - WL = CL unmasked, with stride 1. With no mask the write cycle does not matter. When WL = CL
    nothing is skipped, so the address goes up by one for each vector, as in `stream_form`.
- New decoders: S-32 (0x00), V3-32 (0x08), and V3-8 (0x0A), signed or USN. For V3, w is 0, as
  `unpack_fields` makes it. Each decoder reads only its own vector's bytes: V3-32 reads 8 + 4 bytes
  and V3-8 reads 3 bytes, so nothing is read past the transfer.
- The mask setup for a masked WL 1 command no longer branches. Row 0 of the mask is spread to
  the lanes (the mask byte times 64, 16, 4 and 1 in 16-bit lanes, shifted down 6, then & 3). Four
  `cmpeq` give the take, row, column and keep masks. Then fixed = (row & is-row) | (col0 & is-col).
- `unpack_run` checks for the fast path first. The `written % wl` division now runs only on the
  generic path.
- `test_vif.c`: `unpack_fuzz(trials, fast)`. The first run is the existing 200,000 random trials.
  A second run of 100,000 trials uses only the shapes `stream_simd` takes: mode 0, WL 1 with CL
  1-6 or WL = CL, every format, masked or not, USN, random masks, rows, columns, counts,
  addresses and DMA splits.

## Method

- **Unit tests.** `python port/tools/test_runtime.py` (exit 0), whose VIF lines print:
  ```
  VIF UNPACK fast paths: 200000 trials, 16140614 vectors, 0 differing
  VIF UNPACK fast paths (SIMD shapes): 100000 trials, 8068594 vectors, 0 differing
  VIF1 upload, double buffering, MSCNT and DIRECT tests: 0 failures
  ```
  - The same fuzz was also built for wasm32 (wasi-sdk, `-msimd128`, the simde shim the browser
    build uses) and run under node. It printed 0 differing, so the simde translation is covered
    too.
  - To check that the fuzz catches mistakes, four deliberate bugs were each built and run for
    4,000 trials: a wrong lane multiplier, the wrong V3-32 z word, stride CL for WL = CL, and the
    row/column compare swapped. They gave 2696, 163, 486 and 2704 differing trials.
- **Race identity.** Base `vu.wasm` against new `vu.wasm`, the same core, swapped with
  `run_headless.mjs --vu`:
  ```
  NAV='0:triangle|cross,15:cross,3:cross,16:cross,1:cross,11:cross,18@4C7F38=0:start,18@4C7F38=1:cross,9/5:cross'
  PAD='3:2:cross,23:2:cross,43:2:cross,6:0.3:left,18:0.3:right,30:0.3:left,42:0.3:right,54:0.3:left'
  node --experimental-wasm-jspi port/web/run_headless.mjs --vu VU.wasm --fields 4300 [--trace-off | --trace PREFIX] \
    --iso DISC --env "DHD_COMPARE_NAV=$NAV" --env "DHD_NAV=$NAV" --env "DHD_COMPARE_RACE_SEED=80728" \
    --env "DHD_RACE_PAD=$PAD" --env "DHD_RACE_SYNC=1"
  python port/tools/trace_columns.py base.tsv new.tsv
  ```
- **Micro-benchmark** (scratch, not committed). It builds a synthetic field shaped like OP3's
  table: the ten forms with their command counts and vectors per command, in random order, an
  STMASK before each masked command, and one transfer about every 4 commands. The field goes
  through `vif_feed` many times, and the result is the best of 40 repetitions. It was built for
  x64 (clang -O2) and for wasm (wasi-sdk with the browser's flags, run in node). Both variants
  leave the same data memory checksum.

## Numbers

- **Identity.** Every run of each build gives `vu_steps 82315732`, `vu_blocks 82315732` and
  `vu_native 4545648`: 7 base runs and 6 new runs without a trace, and 1 each with a trace. The
  state traces (4300 rows) PASS with every column identical (menu, phase, clock, ram, scratch,
  hw, cpu, vu0, gs_stream, gs_regs, gs_vram, sound, code), and the `.ptrs.tsv` files are byte
  identical.
- **Micro-benchmark, µs a field** (best of 40, alternating runs, other builds on the PC):

  | build | base | new | change |
  |---|---|---|---|
  | wasm (node) | 506-599 | 399-480 | -21% |
  | x64 | 612-617 | 499-503 | -18% |

  By form, wasm, µs (base → new): V3-32 USN 4/4 48.7 → 18.7, V3-8 4/4 57.6 → 10.0, V4-32 4/4
  46.8 → 30.0, S-8 masked 3/1 182 → 159, V2-16 masked 3/1 120 → 110. The WL 1 forms that were
  already SIMD and unmasked did not change.
- **Browser race, fields/s** (headless, 4300 fields, alternating). The PC was shared with other
  agents' builds, so the spread between runs is several fields/s:
  - First set: base 49.31, 49.16, 49.41; new 50.19, 44.91, 48.42.
  - Second set: base 32.87, 36.75, 41.80; new 41.46, 41.53. A third new run took 30 hours
    because the PC went to sleep in the middle of it. Its counters were still identical, but its
    time was not used.

  The expected gain is about 0.1 ms of the VU worker's roughly 18 ms a field, which is below
  0.1 fields/s. That is too small to see in this noise.

## Result

Kept. The output is the same: the unit fuzz (native and wasm), the three VU counters and every
trace column match. UNPACK is about 20% cheaper on both targets: 0.11 ms a field in the wasm
micro-benchmark, about half of OP3's 0.25 ms estimate. The browser race cannot resolve that gain
on a shared PC, and nothing measured is slower.

Left:
- OP3 item 3: widening several vectors per step for S-8, V4-5 and V4-8 at stride 3.
- Decoding the mask once per STMASK instead of once per command (the setup is now a few SIMD
  operations).
- A real VU worker profile (`check_browser.mjs --profile-worker vu.js`), not run here.
