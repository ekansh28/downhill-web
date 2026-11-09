// Where things are in the disc image, read at deploy time from the image itself (deploy.mjs; the
// ranges stay in the deploy's output, never in the repository): its ISO 9660 directory, the
// movies' blocks and each online track's files as blocks. The page's disc store (www/disc_store.js)
// fills the movies last and a room's track first (finding 194).
import fs from 'node:fs';

const SECTOR = 2048;

// Every file in the image: { path: '/LVL/PERU.NGP', lba, size }, in directory order.
export function discFiles(iso) {
  const fd = fs.openSync(iso, 'r'), read = (lba, n) => { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, lba * SECTOR); return b; };
  const files = [];
  try {
    const walk = (lba, size, dir) => {
      const data = read(lba, Math.ceil(size / SECTOR) * SECTOR);
      for (let at = 0; at < size;) {
        const n = data[at];
        if (!n) { at = (Math.floor(at / SECTOR) + 1) * SECTOR; continue; }
        const len = data[at + 32], name = data.toString('latin1', at + 33, at + 33 + len).split(';')[0];
        const flba = data.readUInt32LE(at + 2), fsize = data.readUInt32LE(at + 10);
        if (len && !(len === 1 && data[at + 33] < 2)) {
          if (data[at + 25] & 2) { if (dir.split('/').length < 8) walk(flba, fsize, `${dir}${name}/`); }
          else files.push({ path: dir + name, lba: flba, size: fsize });
        }
        at += n;
      }
    };
    const pvd = read(16, SECTOR);
    walk(pvd.readUInt32LE(156 + 2), pvd.readUInt32LE(156 + 10), '/');
  } finally { fs.closeSync(fd); }
  return files;
}

// [first, last] block pairs as "a-b,c" text, neighbours and overlaps merged.
export function rangesText(pairs) {
  const merged = [];
  for (const [a, b] of [...pairs].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else merged.push([a, b]);
  }
  return { text: merged.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(','), blocks: merged.reduce((n, [a, b]) => n + b - a + 1, 0) };
}

// The movie files (/MOV/*.PSS: the attract loop, the riders' bios, the credits; 57% of the
// image): the blocks wholly inside them. The page's disc store downloads them last, so the levels,
// textures, music and riders are in the browser first.
export function movieBlocks(files, block) {
  const pairs = [];
  for (const f of files.filter(f => /^\/MOV\/.*\.PSS$/i.test(f.path))) {
    const first = Math.ceil(f.lba * SECTOR / block), last = Math.floor((f.lba * SECTOR + f.size) / block) - 1;
    if (last >= first) pairs.push([first, last]);
  }
  return rangesText(pairs);
}

// The game's own table of each track's one-player level name (D_0026EE50, `char *[26]`, indexed by
// the game's track number: online.c TRACK_NAMES), read from the boot executable SYSTEM.CNF names.
const TRACK_LEVELS = 0x26EE50, TRACKS = 26;
export function trackLevels(iso, files) {
  const fd = fs.openSync(iso, 'r');
  try {
    const fileBytes = f => { const b = Buffer.alloc(f.size); fs.readSync(fd, b, 0, f.size, f.lba * SECTOR); return b; };
    const cnf = files.find(f => f.path === '/SYSTEM.CNF');
    const boot = cnf && /BOOT2\s*=\s*cdrom0:\\([^;\s]+)/i.exec(fileBytes(cnf).toString('latin1'))?.[1];
    const exe = boot && files.find(f => f.path === `/${boot.toUpperCase()}`);
    if (!exe) return null;
    const elf = fileBytes(exe);
    if (elf.readUInt32BE(0) !== 0x7f454c46) return null;
    const phoff = elf.readUInt32LE(0x1c), phnum = elf.readUInt16LE(0x2c), loads = [];
    for (let i = 0; i < phnum; i++) {
      const p = phoff + 32 * i;
      if (elf.readUInt32LE(p) === 1) loads.push({ off: elf.readUInt32LE(p + 4), va: elf.readUInt32LE(p + 8), size: elf.readUInt32LE(p + 16) });
    }
    const at = va => { const s = loads.find(s => va >= s.va && va < s.va + s.size); return s ? va - s.va + s.off : -1; };
    const levels = [];
    for (let t = 0; t < TRACKS; t++) {
      const p = at(TRACK_LEVELS + 4 * t), s = p < 0 ? -1 : at(elf.readUInt32LE(p));
      const name = s < 0 ? '' : elf.toString('latin1', s, elf.indexOf(0, s));
      levels.push(/^[A-Z0-9_]{1,16}$/.test(name) ? name : null);
    }
    return levels;
  } finally { fs.closeSync(fd); }
}

// What a race on a track reads (measured: port/web/run_headless.mjs --disc-log, a single race on
// each track from the load screen to GO, finding 194): its level's files (/LVL, /PTS, /RST
// <level>.*), its area's load screen (/LOADBAR/L<area>SE.*) and sound bank (/SND/<bank>.BNK), and on
// every track the riders (raceFiles). The area comes from the level's name: the first prefix it
// starts with. Not the music (/VAG: a different piece each race) nor /SKAT (a few KiB a second).
const AREAS = [
  ['ALP', 'ALP', 'ALPS_S'], ['AUB', 'AUB', 'AUBE_S'], ['BC', 'BC', 'BC_S'], ['CITYMX', 'CIT', 'CITYMX_S'],
  ['CITYTD', 'CIT', 'CITYTD_S'], ['CITY', 'CIT', 'CITY_S'], ['FUJI', 'FUJ', 'FUJI_S'], ['GLACIERT', 'GLA', 'GLACTD_S'],
  ['GLAC', 'GLA', 'GLAC_S'], ['JUNGLE', 'JUN', 'JUNGLE_S'], ['MOAB', 'MOA', 'MOAB_S'], ['MOSH', 'MOSH', 'MOSH_S'],
  ['PERU', 'PER', 'PERU_S']];
export function trackFiles(level, files) {
  const area = AREAS.find(([prefix]) => level.startsWith(prefix));
  const stem = p => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
  return files.filter(f => {
    const dir = f.path.slice(0, f.path.lastIndexOf('/')), name = stem(f.path);
    if (/^\/(LVL|PTS)$/.test(dir) && name === level) return true;
    if (dir === '/RST' && f.path === `/RST/${level}.RST`) return true;
    return !!area && ((dir === '/LOADBAR' && name === `L${area[1]}SE`) || f.path === `/SND/${area[2]}.BNK`);
  });
}

// What every race reads whatever the track: the riders' default models and animations (/R/?NOS.*,
// /R/RANIM.NGA), the bikes (/BIKE), the riders' settings (/RST/*.RRS) and the race's own sound banks.
export function raceFiles(files) {
  return files.filter(f => /^\/R\/[A-Z]NOS\.\w+$|^\/R\/RANIM\.NGA$|^\/BIKE\/|^\/RST\/\w+\.RRS$|^\/SND\/(RIDER|PCKP|PAUSE)_S\.BNK$/.test(f.path));
}

// Every track's files as blocks: { tracks: { "<game track index>": { level, blocks: "a-b,c" } }, blocks }
// (the blocks touched by them, partly or wholly, the riders' files with each). Tracks whose level the
// image lacks are left out. blocks: the blocks of all of them.
export function trackBlocks(iso, files, block) {
  const levels = trackLevels(iso, files) || [], tracks = {}, all = new Set(), race = raceFiles(files);
  levels.forEach((level, t) => {
    if (!level || !files.some(f => f.path === `/LVL/${level}.NGP`)) return;
    const pairs = [...trackFiles(level, files), ...race].filter(f => f.size > 0)
      .map(f => [Math.floor(f.lba * SECTOR / block), Math.floor((f.lba * SECTOR + f.size - 1) / block)]);
    tracks[t] = { level, blocks: rangesText(pairs).text };
    for (const [a, b] of pairs) for (let i = a; i <= b; i++) all.add(i);
  });
  return { tracks, blocks: all.size };
}
