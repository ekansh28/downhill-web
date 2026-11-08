# 145: the browser's VU1 and GS workers: already split; what limits the race now

2026-11-09, branch `web/vusplit` (from 513ca8f, web/self-host merged up to b0e33e7). Browser only.

Question: finding 087 (BS2, "What is left") says VIF1/VU1 and the GS front end share one worker in
the threaded browser build, and that splitting them needs the reactor twice on one memory (a
`wasm32-wasip1-threads` build: a stack and TLS per instance, a locked malloc, passive data) and
`gs_queue.inc`'s ring between the two. Do that, keeping the pictures identical.

## Answer: the split is there since finding 090 SP4

087's "What is left" was written before SP4 and was never updated. Today's threaded build
(`python port/tools/build.py --web`) runs three workers on one shared memory:

| worker | module | does |
|---|---|---|
| game (`www/worker.js`) | `dhd_core.wasm` + `gqueue.wasm` | the EE; queues every graphics call into ring 1 (0x07A00000) |
| VU (`www/vu.js`) | `vu.wasm` (`vif.c`, `vu0_interp.c`, `web_queue.c` with `WEB_QUEUE_VU`) | ring 1's consumer: VIF1 and VU1, VU1 calls; passes the rest on through ring 2 |
| GS (`www/graphics.js`) | `graphics.wasm` + the Rust renderer | ring 2's consumer (0x07A00800): the GS front end, WebGPU, the canvas |

SP4 needed no threads build of the reactor: VIF1/VU1 is a second module of its own (`vu.wasm`,
span 0x58000000-0x5C000000, its own FP control word 0x07800080 and helper stack 0x079A0000), not
the reactor instantiated twice. Ring 2 is the browser's `gs_queue.inc`: VU1's XGKICK/DIRECT words
are copied into it (`WQ_GIF`), the GS's packets of ring 1 go by reference (`WQ_REF`), and `WQ_MARK`
retires ring 1 once both stages are done with it. The waits match the native ones: a waited VU1
call or `host_service_graphics_wait` waits for both stages, as natively `ps2_vu1_regs_sync` and
`graphics_wait` wait for the VU thread and then the GS thread.

So there is no VU1/GS serialisation left to remove in the browser; the two run as a pipeline.

## Where the time goes now (race, unpaced, Edge headless, scale 2)

CPU profile of the three workers, base build, race fields 3834-4556 (12.1 s, 59.7 fields/s;
`host_pacing_config`'s period forced to 1 ms in a scratch copy of `worker.js`), self time:

| worker | samples | |
|---|---|---|
| game | 38.4% `web_x_host_service_graphics_wait` (waiting for the graphics workers), the rest the game, VU0 and its float helpers, sound |
| VU | 61.5% `run_micro` (the VU1 interpreter), 9.2% `native_clip_run`, 6.7% `vif_feed`, 2.8% `graphics_gif_feed`, ~4% AOT blocks; 9.7% `web_vq_run` (its spin and wait) |
| GS | 41.2% `web_q_run` (mostly its spin before returning), 19.6% idle; `native_draw` 8.4%, `graphics_gif_feed` 8.2%, `gs_write` 5.6%, `writeBuffer` 5.0% |

The VU worker is the limit: busy about 90% (about 15 ms of a 16.7 ms field), the GS worker under
half busy, and the game worker waits 38% of its time for VU1. The "~16.3 ms to max(8.5, 6.9) ms"
estimate of the task assumed the two still shared a worker; the remaining cost is VU1 itself
(`run_micro`, the programs no native kernel or AOT block covers; finding 090 OP3), on one worker
as natively on one thread.

## Tried: deferred vsync (finding 090 HO1) in the browser, not kept here

The other place where the stages wait for each other is the vsync: the browser's host answers
`host_service_graphics_threaded() == 1`, so `kernel.c` waits for the whole field at each vsync,
while the native hosts (2) queue the VBLANK and let the EE run up to two fields ahead. A
prototype (`gqueue.wasm`'s `web_x_host_service_graphics_vblank` and marker numbers on
`WQ_VBLANK`/`WQ_VSYNC`, `graphics_queue.c`'s scheme step for step) was built and checked:

- Race state trace, `run_headless.mjs --fields 4300` (race_compare's NAV, its race pad, seed
  80728), prototype (deferred) against the base build's modules with `DHD_SYNC_STRICT=1`:
  `trace_columns.py` PASS, all 13 columns identical (`gs_stream`, `gs_regs`, `gs_vram`, `cpu`
  included); VU counters equal (`vu_native` 4302659, `vu_steps` 79439878).
- Browser, fields/s (Edge headless, fresh profile per run, other builds on the PC; base is
  the same build with `?env.DHD_SYNC_STRICT=1`, run order alternated):

| run | title 300-1000 | countdown 3000-3500 | race 3500-4300 | race 4300-5000 |
|---|---|---|---|---|
| paced, base 1 / deferred 1 | 40.3 / 40.6 | 41.3 / 52.4 | 46.1 / 56.5 | 45.9 / 54.7 |
| paced, base 2 / deferred 2 | 40.7 / 41.7 | 49.7 / 50.6 | 57.3 / 57.0 | 57.3 / 55.2 |
| unpaced, deferred 1 / base 1 | 45.6 / 41.2 | 51.6 / 50.7 | 59.1 / 58.1 | 57.4 / 54.8 |
| unpaced, deferred 2 / base 2 | 42.6 / 41.9 | 49.9 / 50.3 | 57.8 / 57.4 | 55.4 / 55.0 |

The pairs differ within the noise (base 1's paced race is the outlier); with the VU worker at
~90%, letting the EE run ahead buys little. Deferred vsync is the `web/pacing` lane's work (the
same approach on `web_queue.c`), so the prototype is not on this branch; its diff and runs were
kept outside the repository for that lane.

## Also on this branch

- `run_headless.mjs` stopped at boot (`unsupported headless service host_service_net_get_lobby`):
  `online.c` asks for the lobby outside online races too. It now answers NET_IDLE, all zero, and
  an empty chat, in the sizes `dhd_net.wasm` reports. (`web/pacing` carries a similar stub; when
  both are merged, keep one.)

## What is left

- VU1 on the VU worker: the uncovered microprograms (`run_micro`) are the browser race's limit.
  Finding 090 OP3 lists them; more AOT blocks or native kernels for them would help the browser
  and x64 alike.
- The GS worker is under half busy: room to take work off the VU worker (e.g. the XGKICK copy,
  2.8%) or off the core.
- 087's "What is left" still describes the pre-SP4 build; this finding supersedes that item.

Sources: findings 087 (BS2), 090 (SP4, HO1, OP3); `port/web/web_queue.h`/`.c`,
`port/hle/graphics_queue.c`, `gs_queue.inc`.
