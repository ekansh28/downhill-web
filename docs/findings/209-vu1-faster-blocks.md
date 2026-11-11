# 209: the browser's VU worker: its time is the native kernels, not the AOT dispatch or blocks

Status: current
Supersedes: part of 198 (what `run_micro`'s share is)
Checked: 2026-11-12

Branch `web/vu1-tier2` from `web/self-host` 491a438, 2026-11-12. Browser only (`vu.wasm`, the VU
worker of findings 197 and 198). Research and tools: no game code changed.

## Goal and acceptance

The VU worker limits online races to the mid-50s fps on the owner's laptop. A research plan
(2026-11-10) asked, in order: profile the worker with the run loop out of line (finding 198),
then do the one of (b) block chaining (follow a known successor instead of `aot_find`) or (c)
static scheduling of the AOT blocks (no scoreboard where the generator can prove a pair
stall-free) that the profile says pays. Any change had to keep the headless race at
`vu_steps 82315732`, `vu_blocks 82315732`, `vu_native 4545648` and its state trace equal in every
column, and be measured not slower by alternating base and new `vu.wasm`.

## Result

- **The profile:** the native VU1 kernels are three quarters of the busy VU worker, the AOT
  blocks a tenth, the run loop (dispatch, `aot_find`, the call, history, counters) under 3%. So
  (b) could save at most ~3% and (c) a part of 10%: neither was done.
- **Two codegen changes the profile suggested were built, proven exact and measured in Edge;
  neither is faster there, so neither is kept** (Surprises): hoisting repeated `v128.const` into
  locals (+20-49% in Node 24, -2 fps in Edge 157) and keeping `run()` and the kernels out of
  line (+15% in Node, none in Edge).
- Kept: the tools to see it. `run_headless.mjs --cpu-profile-vu` profiles the VU worker
  headless (from its start; `vu.cpuprofile.json` beside it says where field `--from` begins),
  and `port/tools/vu_profile.py` splits a profile (headless or `check_browser.mjs
  --profile-worker vu.js`) into run loop, AOT blocks, native kernels, VIF1, wait and the rest.

What is left, for the next lane: the kernels' own arithmetic. `native_geometry_loop` (kinds
0-2: VI13 0x11 at 1040, 1CB0 and 12E0) is 31% of all samples by itself. Its FMACs each clamp
both operands (`operand4`, 8 SIMD ops) although most operands are results of an earlier FMAC,
already clamped by `native_result`; the clamp is idempotent and only the lanes in the dest
matter. A per-kernel proof of which operands are clean (what `vu1_aot.py`'s `FiniteOperands`
does for the blocks) would take about 35 of its clamps off each vertex, roughly a quarter of the
kernel's vector work. Measure such a change in a browser, not in Node (below).

## Method

- Headless race, finding 203's command (race_compare's NAV, its race pad, seed 80728,
  `DHD_RACE_SYNC=1`, 4300 fields), `--trace PREFIX` for the state trace, `--trace-off --from
  3500` for speed, `--vu` to swap the VU module. `trace_columns.py base.tsv new.tsv`.
- Browser: `check_browser.mjs` in Edge 157 (headless, `--force_high_performance_gpu`, a fresh
  profile per run), the same NAV, pad and seed with `DHD_FPS=144` and `DHD_SCALE=2`, run to field
  4600; fps is the mean of the page's history (one sample a second) over race fields 3500-4300.
  The variant's `vu.wasm` was copied over `build/web/vu.wasm` for its run, base and variant
  alternated.
- Variants were built from build/web's `vu-command.json` with a patched copy of
  `vu0_interp.c` (and of the kernel headers), postlinked as `build_graphics.py` does, then
  wasm-opt -O3 -g as `port/web/build.py` does. One compile of `vu0_interp.c` with the AOT
  include takes 30-35 minutes and 7 GB (the object cache hides this in normal builds).
- The PC was shared with two other lanes' builds and runs throughout: treat single numbers as
  rough, the pairs as the measure.

## Surprises

**Where the VU worker's time goes.** Race fields 3500-4300 headless (`--cpu-profile-vu`, `node
--no-wasm-inlining`, 250 us samples), split by `vu_profile.py`. Finding 197's and 198's
`run_micro` share was never the run loop: wasm-opt -O3 inlines `ps2_vu1_run` and `run()` into
vif.c's `run_micro`, and clang had already inlined ten of the thirteen native kernels (single-call
statics) into `run()`. The profile build has to keep them apart in both: `run()` and the kernels
`noinline` in clang, and `--no-inline=run --no-inline=native_* --no-inline=ps2_vu1_run` before
wasm-opt's `-O3` (after it they do nothing).

| build | run loop | native kernels | AOT blocks | VIF1 | other | wait/idle |
|---|---|---|---|---|---|---|
| base (as shipped) | 57.8% `run_micro` (loop + 10 kernels) | 6.7% (`native_clip_run`) | 9.9% | 4.8% | 3.1% | 17.7% |
| `run()` noinline only | 56.8% `run` (loop + 10 kernels) | 18.2% | 9.5% | 4.5% | 4.9% | 6.1% |
| `run()` and kernels noinline | 2.6% | 70.4% | 9.5% | 4.8% | 6.8% | 5.9% |

In the last: `native_geometry_loop` 31.0% of all samples, `native_clip_run` 6.7%,
`native_skin_468` 5.7%, `native_geometry_800` 5.1%, `native_particles_2e48` 4.2%, 260 3.6%,
1638 3.0%, 20c 2.5%, `graphics_gif_feed` 6.1%, `vif_feed` 4.8%; the hottest block
(`aot_block_555`) 1.9%. In Edge (`check_browser.mjs --profile 3700 15 --profile-worker vu.js`,
the shipped build) the shape is the same: `run_micro` 69% of busy, `native_clip_run` 9.5%, the
blocks 10%, the worker 90% busy. All runs gave the base's counters (82315732 dispatches, all
AOT; 4545648 kernel runs).

**V8 builds a `v128.const` at every use (Node 24), but not in Edge 157 once tiered up.**
`native_geometry_loop` holds 930 `v128.const` for a few dozen masks: LLVM's wasm backend
rematerialises constants at each use. A micro-benchmark (24 vector ops on a chain, 20M
iterations): with the constants in locals set before the loop, 130-201 ms against 294-389 ms in
Node 24 (V8 13.6); in Edge 157 the same 203 against 341 ms on the first (baseline) run, then
145/147, 137/125 ms (no difference) once optimised. A pass over the finished `vu.wasm` that put
each function's repeated constants into locals (3537 constants in 415 functions; the module
shrank from 5.8 to 4.0 MB) was exact by construction and by the checks (counters equal, state
trace PASS in all 13 columns, with the base core and with the rebuilt one), and in Node much
faster:

| headless, Node 24, fields/s | run 1 | run 2 | run 3 |
|---|---|---|---|
| base, all 4300 / race 3500-4300 | 43.6 / 38.7 | 42.6 / 35.5 | 41.2 / 32.9 |
| constants hoisted | 55.6 / 46.5 | 54.3 / 46.2 | 55.9 / 48.9 |

but in Edge it was a little slower in every pair (race 3500-4300 fps, base / hoisted, run order
alternated): 50.8 / 49.8, 50.5 / 47.0, 49.7 / 48.4, 53.9 / 48.9, 56.1 / 55.6 (means 52.2 /
49.9). Dropped (477af22). Node is not a stand-in for the browser for codegen-level changes.

**Keeping the kernels out of line does not help Edge either.** The profile build (`run()` and
the kernels not inlined, no other change) ran the race window at 43.7 fields/s headless while
profiled, faster than the shipped build unprofiled (32.9-38.7): Node 24 does badly on the
403 KB `run_micro`. In Edge, race 3500-4300 fps, out of line / base, alternated: 51.3 / 55.3,
50.2 / 48.8, 49.9 / 51.1 (means 50.5 / 51.7). Not kept.

**A compile of the VU module costs half an hour.** `vu0_interp.c` with the 2.3 MB AOT include
(718 blocks, all helpers always-inline) takes 30-35 minutes of one core and 7 GB in wasi-sdk's
clang at -O2. Normal builds never see it (the object cache); a lane that changes
`vu0_interp.c`, the kernels or `vu1_aot.py` pays it on each try.

## Decisions

- **Neither (b) nor (c).** They target the run loop (under 3% of the busy worker) and the block
  bodies (10%), and (c) would add a second, unproven code path to the generator.
- **No VU test beyond the race:** nothing kept changes VU code, so `test_vu1_pcsx2.py` and
  `vu1_seq_diff.py` have nothing new to check (`vu1_seq_diff.py` also needs `dhd.exe` captures,
  which this worktree has none of). The two dropped variants were checked by the counters and the
  state trace (hoisting) or are attribute-only (out of line).

## Sources

PCSX2's microVU (`microVU_Branch.inl`: blocks keyed by their entry pipeline state,
`microRegInfo`, and linked by direct jumps; `mVUsetupBranch`, `normBranchCompile`) is the prior
art for (b) and (c); nothing of it was used, since neither was done. V8's x64 code generator
(`SetupSimdImmediateInRegister`: a vector constant from 64-bit immediates) for the constant
cost. Findings 090 (VU1R, OP3), 197, 198, 201, 203.
