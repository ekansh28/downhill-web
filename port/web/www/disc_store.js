// The streamed disc's store (disc_remote.js, finding 194): a worker of its own that keeps this
// browser's copy of the site's disc image and hands the game worker its blocks.
//
// - The copy: <tag>.iso (sparse) and <tag>.map (one byte per block, 1 when stored) in the origin
//   private file system, through sync access handles (one owner: this worker). It lasts between
//   sessions; a new upload (another tag) drops the old one.
// - The game's reads: the game worker waits on a SharedArrayBuffer (ctrl, below) for one block at a
//   time; this worker answers from the copy, or downloads it first. They always go first.
// - Read ahead: after a block the copy lacks, the next AHEAD blocks.
// - Fill: the rest of the image, FILL_RUN blocks per request and FILL_LANES requests at once
//   (dropped when the game needs a block, and asked again later), so the whole disc ends up here and
//   the game never waits on the network again. Everything but the movies first (the site's `later`
//   ranges, deploy.mjs: 57% of the image is FMV the game plays only when asked), so the levels,
//   textures, music and riders are here in about half the time; then the movies. It pauses while the game is riding (the race's own
//   reads and the online snapshots keep the line) and for a moment after each of the game's misses
//   (a level is loading); the page can pause it too.
//
// ctrl (Int32Array over the shared buffer): [0] state: 0 idle, 1 asked, 2 answered, 3 failed;
// [1] the block asked for; [2] the answer's length. data: the block's bytes.
// FILL_LANES: one request at a time leaves a far link idle between requests (a 230 ms round trip,
// 0.8 s to the first byte: 1.5 MB/s), three keep it full (3.4 MB/s on the same line).
const AHEAD = 16, AFTER_MISS_MS = 1500, NO_COPY_KEEP = 64, FILL_RUN = 16, FILL_LANES = 3, REQUEST_MS = 12000;
let base, tag, size, BLOCK, count, ctrl, data;
let copy = null, map = null, have = null, stored = 0, full = false;
let riding = false, paused = false, lastMiss = 0, fillAt = 0, lateAt = 0, failures = 0, later = null;
const fills = new Set();  // the fill's requests in flight: a game's read aborts them
const ahead = [], inflight = new Map(), spare = new Map();
const bootOrder = [], bootSeen = new Set(), BOOT_MAX = 600;  // the game's first blocks, in order (deploy.mjs ships them)
const stats = { net: 0, netMs: 0, worst: 0, local: 0 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lengthOf = i => Math.min(BLOCK, size - i * BLOCK);

// Blocks first .. first+n-1 in one request (the fill asks for FILL_RUN at a time: fewer requests to
// the site and R2), each checked against its length: a short answer is never kept.
async function download(first, n, signal) {
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // A time limit on every request (the body too): a connection that stalls fails and is asked
      // again, rather than hold the game, which waits for its block, for ever.
      const limit = AbortSignal.timeout(REQUEST_MS + n * 4000), both = signal ? AbortSignal.any([signal, limit]) : limit;
      const t = performance.now(), r = await fetch(`${base}/${tag}/${first}${n > 1 ? `?n=${n}` : ''}`, { signal: both });
      if (r.ok) {
        const all = new Uint8Array(await r.arrayBuffer()), out = [];
        for (let k = 0, at = 0; k < n; k++) { const len = lengthOf(first + k); out.push(all.subarray(at, at + len)); at += len; }
        if (out.some((b, k) => b.length !== lengthOf(first + k))) throw Error(`short answer (${all.length} bytes)`);
        const ms = performance.now() - t;
        stats.net += n; stats.netMs += ms * n; stats.worst = Math.max(stats.worst, ms);
        return out;
      }
      last = `HTTP ${r.status}`;
      if (r.status === 404 || r.status === 409) break;  // the link is gone, or a new upload
    } catch (e) { if (signal?.aborted) throw e; last = e.message; }
    await sleep(250 * (attempt + 1));
  }
  throw Error(`disc blocks ${first}${n > 1 ? `-${first + n - 1}` : ''}: ${last}`);
}

// Blocks written, the data flushed, and only then marked stored in the map: a map never says a
// block is here before its bytes are. A full browser storage stops the writing, not the reading.
function keep(first, blocks) {
  if (!copy || full) {
    blocks.forEach((b, k) => spare.set(first + k, b));
    while (spare.size > NO_COPY_KEEP) spare.delete(spare.keys().next().value);
    return;
  }
  try {
    blocks.forEach((b, k) => copy.write(b, { at: (first + k) * BLOCK }));
    copy.flush();
    blocks.forEach((_, k) => { if (have[first + k] !== 1) { have[first + k] = 1; stored++; } });
    map.write(have.subarray(first, first + blocks.length), { at: first });
    map.flush();
  } catch (e) {
    full = true;
    postMessage({ type: 'log', text: `disc: this browser has no more room for the disc (${e.message}); the rest streams` });
  }
}

function fetchRun(first, n, signal) {
  const p = download(first, n, signal).then(blocks => { keep(first, blocks); return blocks; });
  for (let k = 0; k < n; k++) {
    const q = p.then(blocks => blocks[k]);
    q.catch(() => {});
    inflight.set(first + k, q);
  }
  p.catch(() => {}).finally(() => { for (let k = 0; k < n; k++) inflight.delete(first + k); });
  return p;
}

function load(i) {
  if (have?.[i] === 1) {
    const b = new Uint8Array(lengthOf(i));
    if (copy.read(b, { at: i * BLOCK }) === b.length) { stats.local++; return Promise.resolve(b); }
    have[i] = 0; stored--;
  }
  const s = spare.get(i);
  if (s) return Promise.resolve(s);
  const shared = inflight.get(i);
  const alone = () => fetchRun(i, 1).then(blocks => blocks[0]);
  return shared ? shared.catch(alone) : alone();
}

// the game's reads: they go first, so a fill download in the way is dropped (it comes back later)
async function serve() {
  for (;;) {
    const state = Atomics.load(ctrl, 0);
    if (state !== 1) { const w = Atomics.waitAsync(ctrl, 0, state); if (w.async) await w.value; continue; }
    const i = ctrl[1], local = have?.[i] === 1 || spare.has(i);
    if (bootOrder.length < BOOT_MAX && !bootSeen.has(i)) { bootSeen.add(i); bootOrder.push(i); }
    if (!local && !inflight.has(i)) for (const f of fills) f.abort();
    // The game can't go on without this block, so its read never fails: it is asked again until it
    // comes (the page shows that the game is waiting on the network, from ctrl[3]). Only a gone link
    // or a new upload (404, 409) ends it, as nothing will answer those.
    Atomics.store(ctrl, 3, 1);
    for (let tries = 0; ; tries++) {
      try {
        const b = await load(i);
        data.set(b); ctrl[2] = b.length; Atomics.store(ctrl, 0, 2);
        break;
      } catch (e) {
        const text = String(e.message || e);
        if (tries % 5 === 0) postMessage({ type: 'log', text: `${text}; trying again` });
        if (/HTTP 40[49]/.test(text)) { Atomics.store(ctrl, 0, 3); break; }
        await sleep(Math.min(5000, 500 * (tries + 1)));
      }
    }
    Atomics.store(ctrl, 3, 0);
    Atomics.notify(ctrl, 0);
    if (!local) {
      lastMiss = performance.now();
      for (let j = i + 1; j < Math.min(count, i + 1 + AHEAD); j++) if (have?.[j] !== 1 && !ahead.includes(j)) ahead.push(j);
      while (ahead.length > 4 * AHEAD) ahead.shift();
    }
  }
}

// The next run of missing blocks to fill: [first, n], or null. Two passes over the image: first the
// blocks outside the movies (later[i] 0), then the movies' (1); a run stays within one kind.
function nextRun() {
  const wanted = j => have[j] !== 1 && !inflight.has(j);
  for (const late of [0, 1]) {
    let at = late ? lateAt : fillAt;
    while (at < count && (!wanted(at) || (later ? later[at] : 0) !== late)) at++;
    if (late) lateAt = at; else fillAt = at;
    if (at >= count) continue;
    let n = 1;
    while (n < FILL_RUN && at + n < count && wanted(at + n) && (later ? later[at + n] : 0) === late) n++;
    return [at, n];
  }
  return null;
}

// read ahead (every lane) and fill (the first FILL_LANES, when the game isn't loading or riding)
async function background(lane) {
  for (;;) {
    let i = -1;
    while (ahead.length && i < 0) { const j = ahead.shift(); if (have?.[j] !== 1 && !spare.has(j) && !inflight.has(j)) i = j; }
    if (i >= 0) {
      try { await load(i); failures = 0; } catch { await sleep(Math.min(30000, 1000 * 2 ** failures++)); }
      continue;
    }
    const filler = lane < FILL_LANES;
    const run = filler && copy && !full && !paused && !riding && performance.now() - lastMiss > AFTER_MISS_MS ? nextRun() : null;
    if (!run) { await sleep(filler && copy && stored < count ? 250 : 1000); continue; }
    const abort = new AbortController();
    fills.add(abort);
    try { await fetchRun(run[0], run[1], abort.signal); failures = 0; }
    catch { if (!abort.signal.aborted) await sleep(Math.min(30000, 1000 * 2 ** failures++)); }
    finally { fills.delete(abort); }
  }
}

function progress() {
  postMessage({ type: 'progress', stored, count, block: BLOCK, kept: !!copy, filling: !!copy && !full && stored < count && !paused && !riding,
    net: stats.net, avgMs: stats.net ? stats.netMs / stats.net : 0, worstMs: stats.worst, local: stats.local, boot: bootOrder.length });
  if (bootOrder.length) postMessage({ type: 'boot', order: bootOrder.slice() });
}

onmessage = async e => {
  const m = e.data;
  if (m.type === 'riding') { riding = m.riding; return; }
  if (m.type === 'pause') { paused = m.paused; progress(); return; }
  if (m.type !== 'open') return;
  ({ base, tag, size, block: BLOCK } = m); ctrl = new Int32Array(m.shared, 0, 4); data = new Uint8Array(m.shared, 16, BLOCK);
  count = Math.ceil(size / BLOCK);
  // the movies' blocks ("a-b,c" ranges from the site's /info): filled after everything else
  later = new Uint8Array(count);
  for (const part of String(m.later || '').split(',')) {
    const r = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (r) for (let i = Number(r[1]); i <= Math.min(count - 1, Number(r[2] ?? r[1])); i++) later[i] = 1;
  }
  let note = '';
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('dhd-disc', { create: true });
    for await (const name of dir.keys()) if (!name.startsWith(tag + '.')) await dir.removeEntry(name).catch(() => {});
    copy = await (await dir.getFileHandle(`${tag}.iso`, { create: true })).createSyncAccessHandle();
    map = await (await dir.getFileHandle(`${tag}.map`, { create: true })).createSyncAccessHandle();
    have = new Uint8Array(count); map.read(have, { at: 0 });
    stored = have.reduce((n, b) => n + (b === 1), 0);
  } catch (err) {
    copy?.close(); copy = map = have = null;
    note = err.name === 'NoModificationAllowedError' ? 'the disc is open in another tab' : err.message;
  }
  postMessage({ type: 'ready', stored, count, kept: !!copy, note });
  serve();
  for (let lane = 0; lane < FILL_LANES + 1; lane++) background(lane);  // the fill's lanes and one more for read ahead
  setInterval(progress, 2000);
};
