# 194: A self-hosted browser site, a streamed disc and builds on C:

Status: current
Checked: 2026-11-10

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

## Track first (2026-11-10)

Goal: in an online room whose track is known, that track's files download before anything else,
so the first race there loads from the browser instead of streaming.

What a race reads, measured: `port/web/run_headless.mjs --disc-log PATH` (new: every read of the
image as field, offset, length) on a single race on each track (`DHD_RACE_SETUP=<track>`, the
state trace's race navigation), the reads from the load screen (field 1228) to GO mapped to the
image's files. Every track reads, between 10 and 21 MiB:
- its level's files: `/LVL/<level>.*`, `/PTS/<level>.*` (a few small ones only in some modes),
  `/RST/<level>.RST`; `<level>` is the game's own one-player level name for the track index
  (`D_0026EE50`, online.c `TRACK_NAMES`), which deploy reads from the boot executable on the image;
- its area's load screen `/LOADBAR/L<area>SE.*` and sound bank `/SND/<bank>.BNK` (ALP: `ALPS_S`,
  AUB: `AUBE_S`, CITYMX, CITYTD and CITY their own, GLACIERT `GLACTD_S`, the rest the area's);
- the riders, whatever the track: `/R/?NOS.*`, `/R/RANIM.NGA`, `/BIKE/*`, `/RST/*.RRS`, the
  rider, pickup and pause banks (367 small files, 4.7 MiB; spread over about 25 blocks);
- music: a HIGH stem pair (`/VAG/*HIGH-[LR].VAG`) or a `.VPK`, 1.5-6 MiB. Not tied to the track: the
  same track with another `DHD_RACE_SEED` loaded another piece (PERU GHIGH, then EHIGH; MOAB
  the other way round). Left to the generic fill, as is `/SKAT/DHSKAT.SKX` (a few KiB a second).

Changes:
- `port/web/host/disc_layout.mjs` (new; `deploy.mjs`'s ISO 9660 reading moved there): `discFiles`,
  `movieBlocks`, `trackLevels` (the table from the executable), `trackFiles` and `raceFiles` (the
  rules above as name patterns: no game data in the repository) and `trackBlocks`. `deploy.mjs`
  publishes `DISC_TRACKS`, JSON `{"<track>": {level, blocks: "a-b,c"}}` (26 tracks, 2,993
  characters); the Worker hands it out in `/info` as `tracks`, with `later`, on R2 sites too (only
  for an image of the checked size).
- `net.js` reads `NetLobby.track` (offset 140, which `net_web.c` now asserts with the join code's)
  from the lobby copy the game asks for, and while in a room tells `worker.js`, which tells
  `disc_remote.js` (`track(t)`), which posts `{type: 'priority', ranges, name}` to the store.
- `disc_store.js`: three fill passes, the named track's blocks, the rest outside the movies, the
  movies; a new track starts every search over (the old one's missing blocks are the generic fill's
  again). The game's reads, read-ahead, the pause while riding and after a miss are unchanged. The
  progress message carries the track's share (the page's disc line shows "the room's track first:
  N%") and a log line says when it is all in the browser.
- Bug found by the test and fixed: a fill run dropped for a game read went out of `inflight` a few
  microtasks after the lane had already moved its search back, so the search skipped those blocks
  as in flight and never fetched them in that session. `fetchRun` now settles after its blocks
  leave `inflight` (and leaves a block the game asked again with its own request).

Measured over the real layout (`disc_layout.mjs`, 256 KiB blocks): a track with its riders is
38-87 blocks (9.5-21.8 MiB), 957 blocks for all 26. In the old order every track's last block
(its sound bank, near the end of the non-movie part) came after 1,031-1,050 MiB, about 5 minutes
at 3.4 MiB/s; now 3-6 s of fill. The measured race loads read 56-100 blocks each, of which all but
the music and SKAT ones (14-27 blocks, 3-6 MiB) are in the track's set.

Checks: `node port/web/check_disc_store.mjs` runs the real `disc_store.js` in node (its worker
globals, OPFS and the site faked, zeros served), on a synthetic layout or `--iso PATH` the real one
(`--track 3 --other 22`, 9,655 blocks, 13 s): with no track, every block once and the movies last;
a track named while the fill runs comes next (only runs in flight between), a game read is fetched
first and answered, nothing is filled while riding, a second track named halfway comes next and the
first one's rest later, every block once in the end, the movies still last. Not tested: a real
browser in a real room (no headless room-with-streamed-disc check exists yet); MOSH (23) and DUAL
(21, not offered online): the headless single race on the arena stops with a memory fault at its
load (`DHD_RACE_SETUP=23` forces the arena into a single race), so their area rules are by name.
