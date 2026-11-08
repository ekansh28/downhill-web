// Deploys the browser build as one self-hosted Cloudflare Worker (src/index.ts): the page, its own
// online server, and optionally the owner's disc streamed from R2 behind a private link.
//
//   node port/web/host/deploy.mjs [--dry-run] [--new-key] [--link]
//
// Needs the browser build (python port/web/build.py) and online/server's npm install (its wrangler,
// logged in once with `npx wrangler login`). What to deploy comes from port/web/host/site.local.json,
// which is never committed (it names your buckets, your image and your key):
//   {
//     "name": "dhd-web",                       // the Worker's name
//     "minVersion": "0.7.6",                   // the oldest game build its online server takes
//     "disc": {                                // optional: no "disc", no disc route
//       "source": "assets",                    // "assets": the disc in the site's own files (uploaded
//                                              // with the deploy, ~600 files of 4 MiB, kept at
//                                              // Cloudflare's edge); "r2" (default): from the buckets
//       "object": "Downhill Domination.iso",   // the object's name in each bucket
//       "buckets": { "asia": "dhd-asia", "eu": "dhd-eu", "us": "dhd-us" },  // region -> R2 bucket
//       "iso": "<your local copy of the same image>"   // for the online disc check (disc_check.mjs)
//     }
//   }
// --new-key makes a new private key (the old link stops working) and stores it as the Worker's
// DISC_KEY secret and in site.local.json; --link prints the private link again. Everything staged
// goes to build/web-host/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkImage } from './disc_check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const out = path.join(root, 'build/web-host'), pub = path.join(out, 'public');
const configPath = path.join(here, 'site.local.json');
const args = new Set(process.argv.slice(2));
const die = m => { console.error('deploy: ' + m); process.exit(1); };

if (!fs.existsSync(configPath)) die(`no ${path.relative(root, configPath)} (the comment at the top of this file shows one)`);
const site = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const name = site.name || die('site.local.json: no "name"');
const wranglerBin = path.join(root, 'online/server/node_modules/wrangler/bin/wrangler.js');
if (!fs.existsSync(wranglerBin)) die('run `npm install` in online/server first (its wrangler deploys this site)');
const wrangler = (argv, input) => {
  const r = spawnSync(process.execPath, [wranglerBin, ...argv], { cwd: out, stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], input });
  if (r.status !== 0) die(`wrangler ${argv[0]} failed (${r.status})`);
};

// the private key: before anything is staged, so --link alone stays quick
if (site.disc && (args.has('--new-key') || !site.disc.key)) {
  site.disc.key = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(configPath, JSON.stringify(site, null, 2) + '\n');
  site.disc.keyIsNew = true;
}
const link = () => site.disc && console.log(`private link: https://${name}.<your workers.dev subdomain>/?disc=${site.disc.key}`);
if (args.has('--link')) { link(); process.exit(0); }

// A module without its "name" custom section (function names for profiles and stack traces: a
// download players don't need). Nothing else changes, so the code is the same.
function withoutNames(b) {
  const leb = i => { let n = 0, sh = 0, x; do { x = b[i++]; n += (x & 127) * 2 ** sh; sh += 7; } while (x & 128); return [n, i]; };
  const keep = [b.subarray(0, 8)];
  for (let i = 8; i < b.length;) {
    const [size, at] = leb(i + 1), end = at + size;
    let drop = false;
    if (b[i] === 0) { const [len, s0] = leb(at); drop = Buffer.from(b.subarray(s0, s0 + len)).toString() === 'name'; }
    if (!drop) keep.push(b.subarray(i, end));
    i = end;
  }
  return Buffer.concat(keep);
}

// 1. the page and the modules, laid out as serve.mjs serves them
const www = path.join(root, 'port/web/www'), web = path.join(root, 'build/web');
const modules = ['dhd_core.wasm', 'graphics.wasm', 'gqueue.wasm', 'vu.wasm', 'dhd_settings.wasm', 'dhd_net.wasm', 'dhd_disc.wasm',
  'imports.json', 'renderer/dhd_render.js', 'renderer/dhd_render_bg.wasm'];
for (const m of modules) if (!fs.existsSync(path.join(web, m))) die(`build/web/${m} is missing: run python port/web/build.py`);
// everything but the disc's files, which are written once and kept between deploys
for (const f of fs.existsSync(pub) ? fs.readdirSync(pub) : []) if (f !== 'disc-data') fs.rmSync(path.join(pub, f), { recursive: true, force: true });
fs.mkdirSync(path.join(pub, 'build/renderer'), { recursive: true });
for (const f of fs.readdirSync(www)) if (/^[\w.-]+$/.test(f) && fs.statSync(path.join(www, f)).isFile()) fs.copyFileSync(path.join(www, f), path.join(pub, f));
for (const m of modules) {
  const size = fs.statSync(path.join(web, m)).size;
  if (size > 25 * 2 ** 20) die(`build/web/${m} is ${(size / 2 ** 20).toFixed(1)} MiB: over Workers' 25 MiB per asset`);
  const bytes = fs.readFileSync(path.join(web, m));
  fs.writeFileSync(path.join(pub, 'build', m), m.endsWith('.wasm') ? withoutNames(bytes) : bytes);
}
// The page needs cross-origin isolation (SharedArrayBuffer); a new build is fetched again, never mixed.
fs.writeFileSync(path.join(pub, '_headers'), [
  '/*', '  Cross-Origin-Opener-Policy: same-origin', '  Cross-Origin-Embedder-Policy: require-corp',
  '  Cross-Origin-Resource-Policy: same-origin', '  Cache-Control: no-cache', ''].join('\n'));

// 2. the online disc check of the image the site streams, kept while the image is unchanged
const vars = { MIN_VERSION: site.minVersion || '0.7.6', LEADERBOARD_SUBMIT_MAX: '30' };
const r2 = [];
if (site.disc) {
  const d = site.disc, fromAssets = d.source === 'assets';
  if (!fromAssets) {
    const buckets = d.buckets || die('site.local.json: disc.buckets');
    const bindings = {};
    for (const [region, bucket] of Object.entries(buckets)) {
      const binding = `DISC_${region.toUpperCase().replace(/\W/g, '_')}`;
      bindings[region] = binding; r2.push({ binding, bucket_name: bucket });
    }
    vars.DISC_OBJECT = d.object || die('site.local.json: disc.object');
    vars.DISC_BUCKETS = JSON.stringify(bindings);
  } else if (!d.iso) die('site.local.json: disc.source "assets" needs disc.iso (the image to put in the site)');
  if (d.iso) {
    const stat = fs.statSync(d.iso), keep = path.join(out, 'disc-check.json');
    let check = null;
    try { check = JSON.parse(fs.readFileSync(keep, 'utf8')); } catch { /* none yet */ }
    if (!check || check.size !== stat.size || check.mtimeMs !== stat.mtimeMs) {
      console.log('deploy: working out the online disc check (reads the whole image once)...');
      check = { ...(await checkImage(d.iso)), mtimeMs: stat.mtimeMs };
      fs.writeFileSync(keep, JSON.stringify(check));
    }
    if (check.code !== 1) die(`the image's online check failed: ${check.note}`);
    console.log(`deploy: disc check ${check.digest}${check.note ? ` (${check.note})` : ''}`);
    vars.DISC_CHECK = JSON.stringify({ size: check.size, code: check.code, digest: check.digest, note: check.note });
    if (fromAssets) {  // the image as 4 MiB files (a whole number of the Worker's 16-block runs), named by its hash
      const CHUNK = 4 << 20, tag = check.digest.slice(0, 16), dir = path.join(pub, 'disc-data', tag);
      for (const old of fs.existsSync(path.join(pub, 'disc-data')) ? fs.readdirSync(path.join(pub, 'disc-data')) : [])
        if (old !== tag) fs.rmSync(path.join(pub, 'disc-data', old), { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const count = Math.ceil(stat.size / CHUNK), fd = fs.openSync(d.iso, 'r'), buf = Buffer.alloc(CHUNK);
      let written = 0;
      try {
        for (let i = 0; i < count; i++) {
          const file = path.join(dir, `${i}.bin`), n = Math.min(CHUNK, stat.size - i * CHUNK);
          if (fs.existsSync(file) && fs.statSync(file).size === n) continue;
          fs.readSync(fd, buf, 0, n, i * CHUNK); fs.writeFileSync(file, buf.subarray(0, n)); written++;
        }
      } finally { fs.closeSync(fd); }
      console.log(`deploy: the disc in the site's files: ${count} files of 4 MiB (${written} written now)`);
      vars.DISC_ASSETS = JSON.stringify({ tag, size: stat.size, chunk: CHUNK });
    }
  } else console.log('deploy: no disc.iso, so the streamed disc has no online check (online is refused with it)');
}

// 3. the Worker: online/server's Durable Objects and migrations as its own wrangler.jsonc has them
const server = JSON.parse(fs.readFileSync(path.join(root, 'online/server/wrangler.jsonc'), 'utf8')
  .replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[\]}])/g, '$1'));
const config = {
  name, main: path.relative(out, path.join(here, 'src/index.ts')).replace(/\\/g, '/'),
  compatibility_date: server.compatibility_date, workers_dev: true, observability: { enabled: true },
  assets: { directory: './public', binding: 'ASSETS', run_worker_first: ['/v1/*', '/disc/*', '/disc-data/*', '/site.json'] },
  vars, r2_buckets: r2, durable_objects: server.durable_objects, migrations: server.migrations,
};
fs.writeFileSync(path.join(out, 'wrangler.jsonc'), JSON.stringify(config, null, 2));
if (args.has('--dry-run')) { console.log(`deploy: staged in ${path.relative(root, out)} (dry run)`); process.exit(0); }

wrangler(['deploy']);
if (site.disc?.keyIsNew) wrangler(['secret', 'put', 'DISC_KEY'], site.disc.key);
link();
