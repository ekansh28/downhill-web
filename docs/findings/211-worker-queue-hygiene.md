# 211: the browser's worker queues: batched publication, adaptive spins, fewer allocations

Status: in progress

Branch `web/gs-hygiene` from `web/self-host` 491a438, started 2026-11-12. Browser only
(`port/web/web_queue.c`, `port/web/www`). This file is the lane's plan while it runs.

## Goal and acceptance

Smoother frames in the threaded browser build: fewer slow frames and less CPU taken from the VU
worker, the race's limit (findings 197, 201). A research plan (2026-11-10) listed:

1. `web_queue.c`: the GS worker stores the second ring's `consumed` after every packet; the VU
   worker stores `written` (and notifies a sleeping GS worker) after every XGKICK; both empty
   waits spin 32768 steps before sleeping (the GS worker spent 41% of its time there, the VU
   worker 10%, finding 197).
2. `www/worker.js` and `www/graphics.js`: per-field allocations (the sound copy, the status
   numbers, `pad()`).
3. The Rust renderer: the Z probe's 8-9 buffer writes a field, `setBindGroup(1)` 353-367 times a
   field.

Done when:
- The headless race (finding 203, "Race identity") gives `vu_steps = vu_blocks = 82315732` and
  `vu_native 4545648`, and with `--trace` `python port/tools/trace_columns.py base.tsv new.tsv`
  passes in every column (`gs_stream` and `gs_vram` included).
- `node port/web/check_browser.mjs` races in headless Edge (below) are run before and after,
  alternating, with the spin shares from `--profile-worker`.
- `python tools/check.py docs` and `quick` pass.

Out of scope: VU1 itself (the VU worker's own work), deferred vsync (findings 195, 197).

## Progress

- [x] 2026-11-12: base build at 491a438, the queue and JS changes, a new build.

## Decisions

- Item 3 left as it is. `setBindGroup(1)` is already skipped when the group is unchanged
  (`Pass::set_groups`, finding 087 BS4), and each texture already keeps its bind groups
  (`Tex::groups`, one per sampler for a replacement). The 353-367 calls a field are real texture
  changes; fewer would need textures indexed in the shader. The Z probe's writes come one per
  buffer from the C front end (`gpu_exact.inc`, `dhdr_exact_write`). One write would need a
  staging buffer plus copies, or an ABI change on the exact path, which is game state, to save
  about eight calls a field on the GS worker, which is under half busy.
- The first ring (core to VU worker) keeps publishing and waking per packet: the VU worker is
  the bottleneck, and any delay there is time lost.

## Surprises

## Result
