// The streamed disc's store (www/disc_store.js, finding 194) run as it is, in node: its worker globals
// (postMessage, fetch, the origin private file system, the game's shared buffer) faked here, the
// site's blocks answered at once with zeros. Checks the order its background fill downloads in:
//   - with no track named: everything outside the movies, then the movies, each block once;
//   - a room's track named ({type: 'priority'}): its blocks next, before the rest (only the runs
//     already in flight come between); a game read still goes first; nothing while riding;
//   - another track named halfway: its blocks next, the first one's rest later, nothing lost.
// The layout: a synthetic image by default (no game data needed), or with --iso the real one,
// read as deploy.mjs reads it (host/disc_layout.mjs: the movies' blocks and every track's files).
//   node port/web/check_disc_store.mjs [--iso PATH] [--track N] [--other N]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { discFiles, movieBlocks, trackBlocks } from './host/disc_layout.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), option = (n, f) => { const i = args.indexOf(n); return i < 0 ? f : args[i + 1]; };
const iso = option('--iso', null), BLOCK = 256 << 10;
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };

// "a-b,c" -> a Set of blocks
const setOf = text => { const s = new Set(); for (const p of String(text || '').split(',')) { const m = /^(\d+)(?:-(\d+))?$/.exec(p);
  if (m) for (let i = Number(m[1]); i <= Number(m[2] ?? m[1]); i++) s.add(i); } return s; };

let size, later, tracks;
if (iso) {
  const files = discFiles(iso);
  size = fs.statSync(iso).size; later = movieBlocks(files, BLOCK).text; tracks = trackBlocks(iso, files, BLOCK).tracks;
} else {
  // 400 blocks: movies at 100-299, two tracks' files spread out (some inside the movies' span, as a
  // level next to a movie), the last block short
  size = 399 * BLOCK + 1000; later = '100-299';
  tracks = { 3: { level: 'ONE', blocks: '20-40,150,310-330' }, 7: { level: 'TWO', blocks: '35-60,380-399' } };
}
const count = Math.ceil(size / BLOCK);
const T = Number(option('--track', Object.keys(tracks)[0])), U = Number(option('--other', Object.keys(tracks).find(k => Number(k) !== T)));
if (!tracks[T] || !tracks[U]) { console.error(`no tracks ${T} and ${U} in the layout`); process.exit(2); }
const movies = setOf(later), first = setOf(tracks[T].blocks), second = setOf(tracks[U].blocks);
console.log(`layout: ${count} blocks, ${movies.size} of movies; track ${T} (${tracks[T].level}) ${first.size} blocks, track ${U} (${tracks[U].level}) ${second.size}`);

// One store, run from its source in a context of its own.
function store() {
  const fetches = [], messages = [], files = new Map();
  let delay = 1, onFetch = () => {};
  const handle = name => {
    let bytes = files.get(name) || new Uint8Array(0);
    const big = name.endsWith('.iso');  // the copy: its bytes aren't kept (zeros anyway)
    return {
      read(b, { at }) { if (big) return b.length; const n = Math.max(0, Math.min(b.length, bytes.length - at)); b.set(bytes.subarray(at, at + n)); return n; },
      write(b, { at }) { if (big) return b.length; if (at + b.length > bytes.length) { const g = new Uint8Array(at + b.length); g.set(bytes); bytes = g; }
        bytes.set(b, at); files.set(name, bytes); return b.length; },
      flush() {}, close() {},
    };
  };
  const dir = { async getDirectoryHandle() { return dir; }, async *keys() { yield* files.keys(); }, async removeEntry(n) { files.delete(n); },
    async getFileHandle(n) { if (!files.has(n)) files.set(n, new Uint8Array(0)); return { createSyncAccessHandle: async () => handle(n) }; } };
  const context = {
    console, performance, setTimeout, clearTimeout, setInterval, clearInterval, Atomics, SharedArrayBuffer, AbortController, AbortSignal,
    Promise, Uint8Array, Int32Array, Map, Set, Error, Math, Number, String, Boolean, JSON, Array, Object, RegExp,
    navigator: { storage: { getDirectory: async () => dir } },
    postMessage: m => messages.push(m),
    fetch: (url, { signal } = {}) => {
      const m = /\/(\d+)(?:\?n=(\d+))?$/.exec(url), at = Number(m[1]), n = Number(m[2] || 1);
      const f = { at, n, t: performance.now() };
      fetches.push(f); onFetch(f);
      return new Promise((done, fail) => {
        const end = Math.min(size, (at + n) * BLOCK) - at * BLOCK;
        const timer = setTimeout(() => { f.ok = true; done({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(end) }); }, delay);
        signal?.addEventListener('abort', () => { clearTimeout(timer); f.aborted = true; fail(signal.reason); });
      });
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(here, 'www/disc_store.js'), 'utf8'), context, { filename: 'disc_store.js' });
  const shared = new SharedArrayBuffer(16 + BLOCK), ctrl = new Int32Array(shared, 0, 4);
  const send = m => context.onmessage({ data: m });
  send({ type: 'open', base: 'https://site/disc/KEY', tag: 'TAG', size, block: BLOCK, shared, later });
  return {
    fetches, messages, send, ctrl,
    set delay(ms) { delay = ms; }, set onFetch(f) { onFetch = f; },
    // the game's read of block i, as disc_remote.js asks it; resolves when it is answered
    async read(i) {
      ctrl[1] = i; Atomics.store(ctrl, 0, 1); Atomics.notify(ctrl, 0);
      while (Atomics.load(ctrl, 0) === 1) await new Promise(r => setTimeout(r, 1));
      const state = Atomics.load(ctrl, 0); Atomics.store(ctrl, 0, 0); return state;
    },
    stored: () => { const p = [...messages].reverse().find(m => m.type === 'progress'); return p?.stored; },
  };
}
const until = async (cond, ms = 120000) => { const end = performance.now() + ms; while (!cond()) { if (performance.now() > end) return false; await new Promise(r => setTimeout(r, 5)); } return true; };
const blocksOf = fs => fs.flatMap(f => Array.from({ length: f.n }, (_, k) => f.at + k));
const done = f => f.ok;  // answered (not dropped, nor still in flight)

// 1. No track: every block once, everything outside the movies before the first movie block.
{
  const s = store();
  const all = () => new Set(blocksOf(s.fetches.filter(done))).size >= count;
  check(await until(all), 'no track: the whole image is fetched');
  const order = blocksOf(s.fetches.filter(done)), firstMovie = order.findIndex(b => movies.has(b));
  check(order.length === count, `no track: each block once (${order.length} for ${count})`);
  check(order.slice(firstMovie).every(b => movies.has(b)), `no track: the movies last (from fetch ${firstMovie} of ${order.length})`);
  check(s.fetches.every(f => blocksOf([f]).every(b => movies.has(b)) || blocksOf([f]).every(b => !movies.has(b))), 'no track: no run mixes movies and the rest');
}

// 2. Track named after the fill started; a game read during it; riding; another track halfway.
{
  const s = store();
  s.delay = 20;
  await until(() => s.fetches.length >= 6);
  s.send({ type: 'priority', ranges: tracks[T].blocks, name: tracks[T].level });
  const at = s.fetches.length;
  // the runs in flight then (at most the 3 lanes) finish; every run after them is the track's
  await until(() => first.size <= new Set(blocksOf(s.fetches.filter(done)).filter(b => first.has(b))).size || s.fetches.length > at + count);
  const after = s.fetches.slice(at), trackDone = after.findIndex((f, k) =>
    [...first].every(b => blocksOf(s.fetches.slice(0, at + k + 1).filter(done)).includes(b)));
  const between = after.slice(0, trackDone + 1);
  check(trackDone >= 0, `track ${T}: all its ${first.size} blocks fetched (${trackDone + 1} requests after it was named)`);
  check(between.every(f => blocksOf([f]).every(b => first.has(b))), `track ${T}: nothing else fetched before its blocks are all here`);

  // a game read of a block outside the track and not here yet, while the fill runs (new track U)
  s.send({ type: 'priority', ranges: tracks[U].blocks, name: tracks[U].level });
  const outside = [...Array(count).keys()].find(b => !first.has(b) && !second.has(b) && !blocksOf(s.fetches).includes(b) && !movies.has(b))
    ?? [...Array(count).keys()].find(b => !first.has(b) && !second.has(b) && !blocksOf(s.fetches).includes(b));
  const before = s.fetches.length, state = await s.read(outside);
  const own = s.fetches.slice(before).findIndex(f => f.at === outside && f.n === 1);
  check(state === 2 && own === 0, `a game read of block ${outside} is fetched first and answered (state ${state}, request ${own})`);

  // riding: nothing is filled (after the runs in flight); then it goes on
  s.send({ type: 'riding', riding: true });
  await new Promise(r => setTimeout(r, 2500));  // past the pause after a miss, and the runs in flight
  const ridingAt = s.fetches.length;
  await new Promise(r => setTimeout(r, 1000));
  check(s.fetches.length === ridingAt, `riding: no fill requests (${s.fetches.length - ridingAt} in a second)`);
  s.send({ type: 'riding', riding: false });

  // track U's blocks come before the rest (some may be here already: the first track's, or the read)
  const resumed = s.fetches.length;
  await until(() => [...second].every(b => blocksOf(s.fetches.filter(done)).includes(b)));
  // (the lanes went on with it while the game's read was answered, so some may be here before riding)
  const uDone = [...second].every(b => blocksOf(s.fetches.slice(0, resumed).filter(done)).includes(b)) ? -1
    : s.fetches.slice(resumed).findIndex((f, k) => [...second].every(b => blocksOf(s.fetches.slice(0, resumed + k + 1).filter(done)).includes(b)));
  const uRuns = s.fetches.slice(resumed, resumed + uDone + 1);
  check(uRuns.every(f => blocksOf([f]).every(b => second.has(b))), `track ${U}: its blocks next (${uDone + 1} requests after riding)`);

  // the rest: every block once in the end, no movie before the rest
  await until(() => new Set(blocksOf(s.fetches.filter(done))).size >= count);
  const order = blocksOf(s.fetches.filter(done)), unique = new Set(order);
  check(unique.size === count, `after both tracks: the whole image (${unique.size} of ${count} blocks)`);
  check(order.length === count, `after both tracks: each block once (${order.length} fetched)`);
  // (the game's read and the 16 read ahead after it come when the game wants them)
  const ahead = b => b >= outside && b <= outside + 16, early = b => first.has(b) || second.has(b) || ahead(b);
  const tail = order.slice(order.findIndex(b => movies.has(b) && !early(b)));
  check(tail.every(b => movies.has(b) || early(b)), 'after both tracks: the movies still last');
  s.send({ type: 'pause', paused: true });
  const p = s.messages.filter(m => m.type === 'progress').pop();
  check(p?.track?.name === tracks[U].level && p.track.stored === p.track.count, `progress names track ${U} and has all of it (${JSON.stringify(p?.track)})`);
  check(s.messages.some(m => m.type === 'log' && m.text.includes(tracks[U].level)), 'a log line says the track is in the browser');
}

if (failures.length) { console.error(`${failures.length} failed`); process.exit(1); }
console.log('all passed');
process.exit(0);
