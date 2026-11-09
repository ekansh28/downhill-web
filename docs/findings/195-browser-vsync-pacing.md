# 195: browser deferred vsync and display pacing: not kept

Status: current
Checked: 2026-11-09

2026-11-09, branch `web/pacing` (44b2cc4, from f2d63d6). Browser only. Not merged; the branch
stays as the reference for this finding.

Question: two ideas to make the threaded browser build's race faster or smoother.

1. Deferred vsync (finding 090 HO1). The browser host answers
   `host_service_graphics_threaded() == 1`, so `kernel.c` waits for the whole field at each vsync.
   The native hosts answer 2, queue the VBLANK, and let the EE run up to two fields ahead.
2. Display pacing. `worker.js` starts each field on a `setTimeout` grid of the core's period
   (59.94 Hz at 60), which beats against a 60 Hz display (a repeated frame about every 17 s), and
   against 120/144 Hz displays at other rates.

## What was built

- Deferred vsync in `gqueue.wasm`: `web_x_host_service_graphics_vblank` queues a `WQ_VBLANK` packet
  behind the drawing after waiting for the field before last (`DHD_FIELDS_IN_FLIGHT=1`: the last
  one), leaves a provisional CSR on the game's page (`gs_vblank`'s change; SIGNAL and FINISH
  settle later), and `web_x_host_service_graphics_wait` puts the exact CSR back after the next
  wait. The VU worker marks the first ring after each `WQ_VBLANK`/`WQ_VSYNC` so the producer can
  wait for those positions. The host reports 2 except where the native host turns it off
  (`DHD_SYNC_STRICT=1`, screenshots, GS captures and dumps, `DHD_PROFILE`, `DHD_VU_SUSPECT`).
- Display pacing: `graphics.js` runs `requestAnimationFrame` on its OffscreenCanvas and writes the
  last frame's time, the measured refresh interval and a frame count to a shared clock (`VCLOCK`).
  When the period is a whole number of refreshes to 2%, `worker.js` puts each field's due time on
  the display's grid; otherwise, or while no frames come (a hidden page), it keeps the timer
  (`?env.DHD_DISPLAY_PACING=0` always keeps it). The status line counts repeated frames and frames
  that got two pictures (`STAT.repeats`, `STAT.doubles`).

## Result

- Deferred vsync: the same scheme was measured in finding 197 ("Tried: deferred vsync"). Race
  state trace identical (`trace_columns.py` PASS, all 13 columns, VU counters equal), but no
  fields/s gain beyond the noise. The VU worker is busy about 90% of each field (VU1's
  `run_micro`), so letting the EE run ahead buys almost nothing.
- Display pacing: not measured, and nothing to measure yet. It only changes anything when the
  game keeps the full period. The browser race runs at about 50-57 fields/s, limited by the VU
  worker, so every field already misses the timer's grid, let alone the display's. Headless Edge
  also gives no real display to judge smoothness on.

Neither change is kept: one makes no difference, and the other cannot help until the race holds
60.

## What is left

- Once VU1 coverage (the `web/vu1aot` lane, finding 090 OP3) gets the browser race to a steady 60,
  measure display pacing on a real 60 Hz and a 120/144 Hz display: repeats and doubles per
  minute, the timer against `requestAnimationFrame`. 44b2cc4 has the code and the counters.
- If deferred vsync is tried again then, the trace check above is the gate; with the VU worker no
  longer the limit, it may then pay.
- `web/pacing`'s `run_headless.mjs` lobby stub duplicates the one merged with finding 197; keep
  145's.
