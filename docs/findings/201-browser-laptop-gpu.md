# 201: the browser races on a laptop's integrated GPU: a tip to switch

Status: current
Checked: 2026-11-09

Branch `web/merge-0713`. Browser only.

## Question

A player: about 60+ fps looking at the sky, much lower facing the track. Where does it go?

## Answer

On a laptop with two GPUs, Chrome and Edge on Windows give WebGPU the GPU Windows set for the
browser, whatever the page asks: `requestAdapter({ powerPreference: 'high-performance' })` answered
Intel gen-9 (UHD) on this machine (i7-10870H, Intel UHD and an RTX 3060 Laptop), the renderer's
`HighPerformance` (port/render/src/web/init.rs) included. Edge with `--force_high_performance_gpu`
answered NVIDIA ampere. The track's view at 2x scale is the GPU's work the sky's isn't.

`check_browser.mjs` (headless Edge, WebGPU), the scripted race (race_compare's NAV and race pad,
seed 80728) with `DHD_FPS=144`, `DHD_SCALE=2`, fps from the page's own history (one sample a
second, the race's fields), run twice each:

| GPU | race fps avg | slowest 10% | min |
|---|---|---|---|
| Intel UHD (the default) | 38.5-49.5 | 33.0-34.3 | 28.6-32.1 |
| RTX 3060 (`--force_high_performance_gpu`, `CHROME_FLAGS`) | 61.4-70.6 | 55.3-56.2 | 51.4-53.2 |

A page can't choose the GPU. The start page asks WebGPU for its adapter and, when it is Intel's,
shows how to set the browser to High performance in Windows' graphics settings.

Also tried: `vu.wasm` at -O3 instead of -O2 (the VU worker, finding 197): the same VU1 work (steps,
blocks and native runs equal over 4300 fields) and no difference beyond the noise in the browser
(Intel, slowest 10%: 33.4 and 33.0 at -O2, 33.5 and 34.3 at -O3). Not kept. The VU worker's own
profile in a race: 52% VU1's blocks (`run_micro`), 23% waiting for packets, 7% clipping, 6% VIF1.
