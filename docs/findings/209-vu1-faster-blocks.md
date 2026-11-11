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

## Decisions

## Surprises

## Result
