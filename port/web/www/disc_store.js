// The streamed disc's store (disc_remote.js, finding 142): a worker of its own that keeps this
// browser's copy of the site's disc image and hands the game worker its blocks.
//
// - The copy: <tag>.iso (sparse) and <tag>.map (one byte per block, 1 when stored) in the origin
//   private file system, through sync access handles (one owner: this worker). It lasts between
//   sessions; a new upload (another tag) drops the old one.
// - The game's reads: the game worker waits on a SharedArrayBuffer (ctrl, below) for one block at a
//   time; this worker answers from the copy, or downloads it first. They always go first.
// - Read ahead: after a block the copy lacks, the next AHEAD blocks.
// - Fill: the rest of the image, in order, FILL_RUN blocks per request (dropped when the game needs
//   a block, and asked again later), so the whole disc ends up here and
//   the game never waits on the network again. It pauses while the game is riding (the race's own
//   reads and the online snapshots keep the line) and for a moment after each of the game's misses
//   (a level is loading); the page can pause it too.
//
// ctrl (Int32Array over the shared buffer): [0] state: 0 idle, 1 asked, 2 answered, 3 failed;
// [1] the block asked for; [2] the answer's length. data: the block's bytes.
const AHEAD = 16, AFTER_MISS_MS = 1500, NO_COPY_KEEP = 64, FILL_RUN = 8, REQUEST_MS = 12000;
let base, tag, size, BLOCK, count, ctrl, data;
let copy = null, map = null, have = null, stored = 0, full = false;
let riding = false, paused = false, lastMiss = 0, fillAt = 0, failures = 0, fillAbort = null;
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
    if (!local && !inflight.has(i)) fillAbort?.abort();
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

// The next run of missing blocks to fill: [first, n], or null.
function nextRun() {
  while (fillAt < count && (have[fillAt] === 1 || inflight.has(fillAt))) fillAt++;
  if (fillAt >= count) return null;
  let n = 1;
  while (n < FILL_RUN && fillAt + n < count && have[fillAt + n] !== 1 && !inflight.has(fillAt + n)) n++;
  return [fillAt, n];
}

// read ahead (both lanes) and fill (the first lane only, when the game isn't loading or riding)
async function background(lane) {
  for (;;) {
    let i = -1;
    while (ahead.length && i < 0) { const j = ahead.shift(); if (have?.[j] !== 1 && !spare.has(j) && !inflight.has(j)) i = j; }
    if (i >= 0) {
      try { await load(i); failures = 0; } catch { await sleep(Math.min(30000, 1000 * 2 ** failures++)); }
      continue;
    }
    const run = lane === 0 && copy && !full && !paused && !riding && performance.now() - lastMiss > AFTER_MISS_MS ? nextRun() : null;
    if (!run) { await sleep(lane === 0 && copy && stored < count ? 250 : 1000); continue; }
    const abort = fillAbort = new AbortController();
    try { await fetchRun(run[0], run[1], abort.signal); failures = 0; }
    catch { if (!abort.signal.aborted) await sleep(Math.min(30000, 1000 * 2 ** failures++)); }
    finally { if (fillAbort === abort) fillAbort = null; }
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
  serve(); background(0); background(1);
  setInterval(progress, 2000);
};
