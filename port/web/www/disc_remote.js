// A disc image streamed from this site (port/web/host, finding 142), read as the game reads a local
// one: synchronously, in the game worker. A few blocks are kept in memory here; the rest comes from
// disc_store.js, which keeps this browser's copy of the whole image (downloaded in the background
// while the game runs, so after the first sessions nothing waits on the network) and downloads a
// block the copy lacks when the game asks for it. The game worker waits for it on a shared buffer.
//
// The site's /info has the size, the tag (the image's version), the block size and the online disc
// check worked out at deploy time (disc_check.mjs), which this browser can't do without the whole
// image.

const MEMORY = 96;    // blocks kept in memory here

export async function createRemoteDisc(base, say, onProgress = () => {}) {
  const got = await fetch(`${base}/info`, { cache: 'no-store' });
  if (!got.ok) throw Error(`the site's disc: ${got.status} ${(await got.text()).slice(0, 200)}`);
  const { size, tag, block: BLOCK, check } = await got.json();
  if (!Number.isSafeInteger(size) || size <= 0 || !BLOCK) throw Error('the site sent no disc size');

  const shared = new SharedArrayBuffer(16 + BLOCK), ctrl = new Int32Array(shared, 0, 4), data = new Uint8Array(shared, 16, BLOCK);
  const store = new Worker('disc_store.js');
  let last = null;
  const ready = new Promise((done, fail) => {
    store.onerror = e => fail(Error(`the disc store: ${e.message}`));
    store.onmessage = e => { const m = e.data;
      if (m.type === 'ready') {
        say(m.kept ? `disc: ${(m.stored * BLOCK / 2 ** 20).toFixed(0)} of ${(size / 2 ** 20).toFixed(0)} MiB already in this browser; the rest downloads while you play`
          : `disc: not kept in this browser (${m.note}); it streams as the game reads it`);
        done();
      } else if (m.type === 'log') say(m.text);
      else if (m.type === 'progress') {
        if (last && m.stored === m.count && last.stored < m.count) say('disc: the whole disc is in this browser now');
        last = m; onProgress(m);
      }
    };
  });
  store.postMessage({ type: 'open', base, tag, size, block: BLOCK, shared });
  await ready;

  function fetchBlock(i) {
    ctrl[1] = i; Atomics.store(ctrl, 0, 1); Atomics.notify(ctrl, 0);
    while (Atomics.load(ctrl, 0) === 1) Atomics.wait(ctrl, 0, 1);
    const state = Atomics.load(ctrl, 0), b = state === 2 ? data.slice(0, ctrl[2]) : null;
    Atomics.store(ctrl, 0, 0);
    if (!b) throw Error(`disc block ${i} could not be read (the log has why)`);
    return b;
  }
  const memory = new Map();
  function block(i) {
    let b = memory.get(i);
    if (b) { memory.delete(i); memory.set(i, b); return b; }
    b = fetchBlock(i);
    memory.set(i, b);
    if (memory.size > MEMORY) memory.delete(memory.keys().next().value);
    return b;
  }

  say(`disc: ${(size / 2 ** 30).toFixed(2)} GiB from this site`);
  let wasRiding = false;
  return {
    size, check,
    progress: () => last,
    riding(r) { if (r !== wasRiding) { wasRiding = r; store.postMessage({ type: 'riding', riding: r }); } },
    pause(p) { store.postMessage({ type: 'pause', paused: p }); },
    read(pos, out) {
      let done = 0;
      while (done < out.length && pos + done < size) {
        const at = pos + done, b = block(Math.floor(at / BLOCK)), off = at % BLOCK;
        const n = Math.min(out.length - done, b.length - off);
        out.set(b.subarray(off, off + n), done); done += n;
      }
      return done;
    },
  };
}
