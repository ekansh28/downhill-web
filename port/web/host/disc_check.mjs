// The online disc check of a disc image, as the game works it out (www/disc.js over
// build/web/dhd_disc.wasm, the native game's own dhd_disc), for a site that streams that image
// (src/index.ts): deploy.mjs passes the answer to the site, and a browser playing the streamed disc
// takes it instead of downloading the whole image to hash it.
//   node port/web/host/disc_check.mjs <image.iso>   prints {size, code, digest, note}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discCheck } from '../www/disc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export async function checkImage(iso) {
  const wasm = fs.readFileSync(path.join(root, 'build/web/dhd_disc.wasm'));
  const fd = fs.openSync(iso, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const answer = await discCheck(wasm, (at, out) => fs.readSync(fd, out, 0, out.length, at), size);
    return { size, ...answer };
  } finally { fs.closeSync(fd); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) { console.error('usage: node port/web/host/disc_check.mjs <image.iso>'); process.exit(2); }
  console.log(JSON.stringify(await checkImage(process.argv[2])));
}
