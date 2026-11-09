# 194: A self-hosted browser site, a streamed disc and builds on C:

Status: current
Checked: 2026-11-09

2026-11-08. `port/web/host/` (README there), `www/disc_remote.js`, `www/disc_store.js`,
`port/tools/drives.py`.

## What failed before

A browser copy of the page was deployed as static assets, and the disc image was read from public
R2 development URLs (`*.r2.dev`, one bucket per region) by HTTP Range requests, as `worker.js`'s
test hook reads `/test-iso`:

- **Slow.** `r2.dev` URLs are rate-limited and meant for development. Every 1 MiB block missed by
  the 48-block memory cache was a synchronous request from the game worker, so the menus and races
  stopped while the music and the level files streamed. Nothing was kept between sessions.
- **ONLINE: "the disc image couldn't be read".** The online check (finding 189) hashes every game
  file on the disc: about 2.4 GB of synchronous Range requests to those URLs. Some fail, and a
  failed read is code -1.
- **Not private.** Anyone with an `r2.dev` URL can download the image.

## What changed

- One Worker (`port/web/host/src/index.ts`) serves the page and modules (Workers static assets,
  `_headers` for COOP/COEP), online/server's routes and Durable Objects unchanged (`/v1/*`), and
  the disc behind a secret key (`DISC_KEY`), read from R2 by binding (the buckets need no public
  access), nearest bucket by `request.cf.continent`, others as fallback, blocks put in the edge
  cache.
- The disc in the browser: 256 KiB immutable blocks (a miss on a slow line costs a quarter of
  what a 1 MiB one did). A store worker (`disc_store.js`) owns the copy in the origin private file
  system (sync access handles: one owner per file) and answers the game worker's synchronous
  reads over a SharedArrayBuffer (`Atomics.wait` there, `Atomics.waitAsync` in the store). A
  missed block goes first, then 16 read ahead, and the rest of the image downloads in the
  background one block at a time, paused while riding and for 1.5 s after a miss, so the whole
  disc ends up local. The page menu shows the share already stored and can pause it.
- The online check of the streamed disc is worked out at deploy time from the owner's local copy
  of the same image (`disc_check.mjs`, the same `dhd_disc` module) and handed out with the size;
  the Worker drops it when the object's size differs. The server compares the hash between the
  room's members as before (it never trusted it more than that).
- `site.json` (`"server": "same-origin"`): the page connects to the site's own server; no address
  is written in the repository.
- Builds on C: (one drive): `DHD_ALLOW_SYSTEM_DRIVE=1` lifts the off-C: rule of `rustgs.py`,
  `objcache.py`, `build_host64.py`, `package_release.py`, `build_launcher.py` and `build_apk.py`,
  all through `port/tools/drives.py`. Off by default.

## Sources

Cloudflare's docs: R2 public development URLs are rate-limited and not for production; Workers
static assets (`_headers`, `run_worker_first`, 25 MiB per file); the Cache API. Whether the Cache
API stores anything on `workers.dev` is unclear from the docs (older pages say no, a 2025 change
reportedly lifted it), which is why the Worker reports `X-Disc-Cache`. MDN:
`FileSystemSyncAccessHandle` (dedicated workers only).

## Faster disc download (2026-11-09)

Measured from this machine to the site (ping 230 ms to its Cloudflare location): a 256 KiB block
1.2-1.7 s (0.6-1 s to the first byte), a 16-block run 1.4-2.1 MB/s, a static 12.9 MB file
3.1-4.2 MB/s; 6 runs at once 3.0 MiB/s, 12 at once 3.4 MiB/s, so the line itself tops out near
3.4 MiB/s. The background fill sent one 8-block run at a time (about 1.5 MB/s), in disc order,
and 1,370 of the image's 2,406 MiB are FMV (`/MOV/*.PSS`: the attract loop, the riders' bios, the
credits), starting at block 79.
- `deploy.mjs` reads the image's ISO 9660 directory and publishes the blocks wholly inside the
  movies as `DISC_LATER` ranges (5,453 blocks, 235 characters); `/info` carries them as `later`.
- `disc_store.js` fills everything else first, then the movies, three 16-block runs at a time; a
  game read still aborts the fill. The game's own reads, read-ahead and the pause while riding
  are unchanged.
- The start card's warm-up of the boot list runs 12 requests at once instead of 6.
- Simulated over the real layout (`nextRun`): every block once, no run mixes the two kinds,
  1,051 MiB before the first movie block: about 5 minutes at 3.4 MiB/s instead of about 25 for
  the whole image at the old rate.
