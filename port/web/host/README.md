# A self-hosted browser site

One Cloudflare Worker that serves the browser build, runs its own online server and, if you want,
streams your own disc image to the people you give a private link. Nothing else is needed: no
other host, no public bucket, no other online server.

| File | What |
|---|---|
| `src/index.ts` | The Worker: the page (static assets with the cross-origin isolation headers), `/v1/*` (online/server, unchanged), `/disc/<KEY>/...` (the disc), `/site.json` |
| `deploy.mjs` | Stages `build/web-host/` (the page, the modules, `wrangler.jsonc`) and deploys it |
| `disc_check.mjs` | The image's online disc check, worked out once at deploy time |
| `disc_layout.mjs` | Where the movies and each online track's files are in the image (block ranges for the page's disc store), read at deploy time |
| `site.local.json` | Your settings: never committed (`.gitignore`) |

## Deploy

1. Build the browser build: `python port/tools/build.py --web` (or `port/web/build.py`).
2. `npm install` in `online/server`, and `npx wrangler login` there once.
3. Put your image in an R2 bucket (one per region if you want: the same object in each). The
   buckets don't need public access; turn it off if it is on, so only the Worker reads them.
4. Write `port/web/host/site.local.json` (the comment at the top of `deploy.mjs` shows one).
5. `node port/web/host/deploy.mjs`. The first time it makes the private key and prints the link,
   `https://<name>.<your subdomain>.workers.dev/?disc=<KEY>`. `--link` prints it again,
   `--new-key` replaces it (the old link stops working), `--dry-run` stages without deploying.

The page then offers **Play this site's disc** to anyone who opened the private link (the key is
kept in their browser, and taken out of the address bar). Everyone else can still play their own
`.iso` file, as on any copy of the page.

## How the disc streams

The image is read in 256 KiB blocks, `/disc/<KEY>/<TAG>/<N>`, where TAG is the R2 object's etag:

- In the browser: `www/disc_remote.js` (the game worker) keeps a few blocks in memory and asks
  `www/disc_store.js` for the rest. The store keeps the browser's copy of the image (the origin
  private file system, kept between sessions): a block the game asks for comes from there, or is
  downloaded first (always before anything else), then the next 16 are read ahead. In the
  background it downloads the rest of the image, one block at a time, so the whole disc ends up in
  the browser and nothing waits on the network any more (in an online room the track's files first, the
  movies last: `disc_layout.mjs`). That download waits while the game is
  riding and for a moment after each of the game's misses, and the page menu (`) has Pause disc
  download and how much is already there.
- In the Worker: the bucket nearest the Cloudflare location that serves the request (by
  continent: `eu`, `us`, `asia`), the others if it fails; each block is put in the edge cache
  (`X-Disc-Cache: HIT` or `MISS` says which answered).
- A new upload has a new etag: the page drops its old copy and the old block URLs answer 409.

## Online

`/site.json` says `"server": "same-origin"`, so the page points the game at the site itself
(`wss://<name>.<subdomain>.workers.dev`) unless `?env.DHD_NET_SERVER=` says otherwise. Players of
the PC game can race there too, with `server = wss://...` in their `dhd.ini`. Rooms are only
shared by games of the same build (core id) and disc check.

The online check normally hashes every game file on the disc. For a streamed disc the page would
have to download the whole image to do that, so `deploy.mjs` works it out from your local copy of
the same image (`disc.iso`) and the Worker hands it out with the disc's size. Without `disc.iso`
there is no online check, and ONLINE refuses the streamed disc.
