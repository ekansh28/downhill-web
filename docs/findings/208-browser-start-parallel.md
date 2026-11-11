# 208: the browser's start compiles the renderer while the core downloads

Status: current
Checked: 2026-11-11

Branch `web/merge-0713`. `port/web/www/worker.js`, `graphics.js`, `graphics_common.js`.

## Goal and acceptance

Press Play to the first field sooner. A performance plan (2026-11-10) found the start serial: the
core (14 MB) downloaded and compiled, then the graphics worker fetched and compiled the Rust
renderer (`dhd_render_bg.wasm`), then made its WebGPU device. Acceptance: the same game, a shorter
time to the first field.

## Decisions

1. **The renderer compiles at once.** `worker.js` starts `compileRenderer()` (streaming) beside the
   core's compile and imports the renderer's JS glue early; the compiled module goes to the
   graphics worker in its start message (a `WebAssembly.Module` can be posted to a worker), and
   the single-thread path uses the same promise. `startRenderer` takes it, or compiles as before.
2. **`graphics.wasm` compiles while it downloads** (`compileStreaming`, it was fetched whole and
   then compiled).
3. Left as they were: the zero check of the renderer's memory window (a safety check) and the
   order graphics worker, then VU worker (the VU worker needs the graphics worker's queue).

## Sources

- V8: streaming compilation and code caching only for streamed modules,
  https://v8.dev/blog/wasm-code-caching

## Checks

- Headless race (4300 fields, new build): `vu_steps` = `vu_blocks` = 82315732, `vu_native` 4545648,
  exit 0: unchanged.
- Edge, `check_browser.mjs` to field 120, alternating old and new start code: both start and run;
  "loaded in" 0.4-0.5 s for both from a warm local server (a cold first run after the build: 2.1 s).

## Surprises

- The gain is small. The renderer module is 437 KB (`vu.wasm`, 5.8 MB, already compiled in
  parallel), so on a real connection this saves about the renderer's download and compile time,
  a few tenths of a second at most, not the 1-3 s the plan estimated; locally it doesn't show.
