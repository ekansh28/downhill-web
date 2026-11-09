# 146: the browser's VU1 already runs entirely in AOT blocks and native kernels

2026-11-09, branch `web/self-host` (7058d96; lane `web/vu1aot`, 8ba3f98). Browser only.

Question: finding 145 found the VU worker is the browser race's limit, with 61.5% of its samples
in `run_micro`, which it read as the VU1 interpreter. Do the race's hot microprograms need more
AOT blocks or native kernels (finding 090 OP3)?

## Answer: no; nothing in the race falls back to the interpreter

`build_graphics.py` adds two counters to the web build's `vu0_interp.c`. `web_vu_steps` counts
each VU1 dispatch of the run loop (an AOT block or one interpreted pair; native kernels are
counted apart, as `web_vu_native`). `web_vu_blocks` counts the dispatches that found an AOT
block. The threaded build of 2026-11-09 (`build/web`, core of 01:18), headless:

    node --experimental-wasm-jspi port/web/run_headless.mjs --fields 4300 --trace-off \
      --env DHD_NAV=<race_compare NAV> --env DHD_COMPARE_RACE_SEED=80728 \
      --env DHD_RACE_PAD=<race_compare RACE_PAD> --env DHD_RACE_SYNC=1

| counter | value |
|---|---|
| `vu_steps` (dispatches) | 82,315,732 |
| `vu_blocks` (AOT dispatches) | 82,315,732 |
| `vu_native` (native kernel runs) | 4,545,648 |
| fields/s (Node, no GPU) | 55.5 |

Every dispatch found its block: the interpreter ran no VU1 pair from boot to field 4300, the race
included. `run()` is `always_inline` into `run_micro`, and the optimiser can inline block
functions into it as well (finding 145 saw only ~4% under separate AOT block frames), so the
blocks' own time shows up as `run_micro`. Finding 145's 61.5% is the AOT blocks and the run loop,
not interpretation (not split further here).

The cheaper levers OP3 named are in the build already: kernels from 12E0 and for loops 0798 and
3140 (`vu0_interp.c`'s native kinds 4096 and 8192, `vu1_native_clip.py`), and lazy flags
(`vu1_aot.py`'s `lazy_flags`, finding 090 VU1R).

## What is left

The VU worker's cost is the same code natively and in wasm; making it cheaper means changing the
blocks themselves, all checked with `test_vu1_pcsx2.py`, `vu1_seq_diff.py` and the race trace:
- the blocks' own flag, clamp and commit work (OP3: in the blocks, flags 41%, clamp 10%,
  commits 9% of their time, before lazy flags);
- VIF1 UNPACK forms (OP3 (b): four forms are 72% of unpack time, about 0.25 ms a field natively);
- the GPU path for the B mesh family (OP3 (c), 100-200 h).
- A browser profile of the VU worker: `check_browser.mjs --profile F S --profile-worker vu.js`
  (added here) profiles that worker instead of the game's. A build with `run()` not inlined
  (`noinline`) would split the blocks from the loop in such a profile.
