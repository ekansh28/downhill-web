"""Self time of the browser's VU worker by part, from a V8 CPU profile (finding 209).

    node --experimental-wasm-jspi --no-wasm-inlining port/web/run_headless.mjs --cpu-profile-vu --from 3500 ...
    python port/tools/vu_profile.py [build/web/vu.cpuprofile] [--top 30]

The run writes build/web/vu.cpuprofile (the VU worker, from its start) and vu.cpuprofile.json (the
wall time of the profile's start and of field --from); only the samples from field --from on
count. Parts: the run loop (run_micro and what is inlined into it: aot_find, the history, the
counters), the AOT blocks (aot_block_*), the native kernels, VIF1, the queue's wait, the rest.
With --no-wasm-inlining V8 keeps each block in its own frame; without it, blocks called through
call_indirect can be inlined into run_micro and count as the loop.
"""
import argparse
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def part(name):
    if re.match(r'aot_block_\d+', name):
        return 'AOT blocks'
    if name in ('run_micro', 'run') or name.startswith('ps2_vu1_') or name == 'ps2_vu_run':
        return 'run loop'
    if name.startswith('native_') or name.startswith('clip_'):
        return 'native kernels'
    if 'vif' in name or 'unpack' in name or 'stream_' in name:
        return 'VIF1'
    if name in ('web_vq_run', '(idle)', '(program)', '(garbage collector)') or 'wait' in name:
        return 'queue wait / idle'
    return 'other'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('profile', nargs='?', type=Path, default=ROOT / 'build/web/vu.cpuprofile')
    ap.add_argument('--top', type=int, default=30)
    a = ap.parse_args()
    prof = json.loads(a.profile.read_text())
    meta_path = a.profile.with_name(a.profile.name + '.json')
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    names = {n['id']: n['callFrame']['functionName'] or '(anonymous)' for n in prof['nodes']}
    # sample times: startTime plus the running sum of timeDeltas, microseconds of the profiler's clock
    t, cut = prof['startTime'], None
    if meta.get('fromWall') and meta.get('profileWall'):
        cut = prof['startTime'] + (meta['fromWall'] - meta['profileWall']) * 1000
    self_time = Counter()
    for node, delta in zip(prof['samples'], prof['timeDeltas']):
        t += delta
        if cut is None or t >= cut:
            self_time[names[node]] += 1
    total = sum(self_time.values())
    parts = Counter()
    for name, n in self_time.items():
        parts[part(name)] += n
    print(f'{total} samples' + (f' from field {meta.get("from")}' if cut else ' (whole run)'))
    busy = total - parts['queue wait / idle']
    for name, n in parts.most_common():
        print(f'  {name:20} {100 * n / total:5.1f}%' + (f'  ({100 * n / busy:5.1f}% of busy)' if name != 'queue wait / idle' and busy else ''))
    print('top functions:')
    for name, n in self_time.most_common(a.top):
        print(f'  {100 * n / total:5.1f}%  {name}')


if __name__ == '__main__':
    main()
