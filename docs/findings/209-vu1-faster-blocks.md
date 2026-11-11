# 209: the browser's VU worker: where its time goes, and faster VU1 dispatch or blocks

Status: in progress

Branch `web/vu1-tier2` from `web/self-host` 491a438, started 2026-11-12. Browser only (`vu.wasm`,
the VU worker of findings 197 and 198); the code it touches (`port/runtime/vu0_interp.c`,
`port/tools/vu1_aot.py`) is shared with the x64 build.

## Goal and acceptance

The VU worker limits online races to the mid-50s fps on the owner's laptop. Profile it first
(finding 198 proposed a `noinline` profile build), then do the one of block chaining or static
scheduling of the AOT blocks that the profile says pays. Done when:
- the headless race (finding 203's command) gives `vu_steps 82315732`, `vu_blocks 82315732`,
  `vu_native 4545648` and a state trace equal to the base build's in every column
  (`trace_columns.py`);
- `test_vu1_pcsx2.py`, `vu1_seq_diff.py` and `test_runtime.py` pass;
- it is not slower, measured by alternating base and new `vu.wasm` (`run_headless.mjs --vu`).

## Progress

- [x] 2026-11-12: `run_headless.mjs --cpu-profile-vu` and `port/tools/vu_profile.py` (29ed5b2)
- [x] 2026-11-12: the profile (Surprises): the native kernels are 75% of the busy VU worker, the
  AOT blocks 10%, the run loop 3%. Neither block chaining nor static scheduling can pay much.
- [ ] 2026-11-12: `port/web/hoist_consts.py`: repeated `v128.const` into locals after wasm-opt

## Decisions

- **Neither (b) nor (c).** The research plan's two block items target the run loop (under 3% of
  the busy worker) and the block bodies (10%). Block chaining could save at most the first;
  static scheduling a part of the second, at the cost of a second, unproven code path in the
  generator. Not done; the time went where the profile pointed instead.
- **A wasm pass, not a C change.** The constants are LLVM's and V8's business, so the fix is a
  pass on the finished `vu.wasm` (`port/web/hoist_consts.py`, run by `port/web/build.py` after
  wasm-opt -O3, which would fold the constants back). It changes no C, so the x64 build and the
  VU tests' code are untouched, and it is exact by construction: each `local.get` reads the value
  the `v128.const` it replaces would have made. The pass decodes every rewritten body again and
  refuses one that does not decode to its end with the constants left only in its prologue.
- **Only `vu.wasm`.** The core (2057 constants in 888 functions) and `graphics.wasm` (28) would
  take the same pass; neither worker is the race's limit (finding 197), so they are left for a
  measured follow-up.
- Constants used once are not hoisted (`--min-uses 2`): 116 more in 9 more functions, nothing
  to share.

## Surprises

**Where the VU worker's time goes.** Race fields 3500-4300 headless (`run_headless.mjs
--cpu-profile-vu --from 3500`, `node --no-wasm-inlining`, 250 us samples), split by
`vu_profile.py`. Finding 197's and 198's `run_micro` share was never the run loop: wasm-opt -O3
(port/web/build.py) inlines `ps2_vu1_run`, `run()` and, through clang's own inlining of
single-call statics, ten of the thirteen native kernels into vif.c's `run_micro`. A profile
build had to keep them apart twice: `run()` and the kernels `noinline` in clang, and
`--no-inline=run --no-inline=native_* --no-inline=ps2_vu1_run` before wasm-opt's -O3.

| build | run loop | native kernels | AOT blocks | VIF1 | other | wait/idle |
|---|---|---|---|---|---|---|
| base (as shipped) | 57.8% `run_micro` (loop + 10 kernels) | 6.7% (`native_clip_run`) | 9.9% | 4.8% | 3.1% | 17.7% |
| `run()` noinline only | 56.8% `run` (loop + 10 kernels) | 18.2% | 9.5% | 4.5% | 4.9% | 6.1% |
| `run()` and kernels noinline | 2.6% | 70.4% | 9.5% | 4.8% | 6.8% | 5.9% |

In the last: `native_geometry_loop` (kinds 0-2, VI13 0x11 at 1040/1CB0/12E0) 31.0% of all
samples, `native_clip_run` 6.7%, `native_skin_468` 5.7%, `native_geometry_800` 5.1%,
`native_particles_2e48` 4.2%, 260 3.6%, 1638 3.0%, 20c 2.5%; `graphics_gif_feed` 6.1%; the
hottest block (`aot_block_555`) 1.9%. Counters equal to the base's in every run (82315732
dispatches, all AOT; 4545648 kernel runs). So the run loop's whole cost (dispatch, `aot_find`,
the call, history, counters) is under 3% of the busy worker, and the blocks' bodies 10%: block
chaining (b) could win at most ~3%, static scheduling (c) a fraction of 10%. The lever is the
kernels' own code.

**V8 materialises every `v128.const` where it is used.** `native_geometry_loop` has 930
`v128.const` (wasm-objdump of the profile build) for a few dozen distinct masks (the operand
clamp's 0x7fffffff, 0x00800000, 0x7f7fffff, the lane masks of `native_merge`, ...): LLVM's wasm
backend rematerialises constants at each use, and V8 neither shares equal ones nor hoists them
out of a loop. A micro-benchmark (24 vector ops in a loop, 20M iterations, Node 24): the same
loop with its constants in locals set before the loop runs in 130-201 ms against 294-389 ms
with `v128.const` at each use (24 distinct values), 142-178 against 289-297 ms (4 values).

## Result
