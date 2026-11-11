"""Hoist repeated v128 constants into locals (finding 209), after wasm-opt.

V8 materialises a wasm `v128.const` at every use (a 64-bit immediate into a general register,
then into the vector register, twice for a non-splat value): it neither shares equal constants
nor moves them out of a loop. LLVM's wasm backend, for its part, rematerialises a constant at
each use rather than keep it in a local. The VU worker's code (the native VU1 kernels, the AOT
blocks, the clipping routine) is full of the same few masks: native_geometry_loop alone has 930
`v128.const` for a few dozen values. This pass gives each function one local per constant value
it uses at least --min-uses times, sets the locals once at the function's start and turns each
use into a `local.get`. Constants are constants: the module computes exactly what it computed
before. All-zero and all-ones vectors are left alone (V8 makes them in one instruction).

It must run after wasm-opt (port/web/build.py), whose optimiser would put the constants back.

    python port/web/hoist_consts.py IN.wasm OUT.wasm [--min-uses 2]
"""
import argparse
import collections
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'port/tools'))
from wasm_postlink import Module, V128, enc_u, instructions, uleb  # noqa: E402

V128_CONST = 12  # 0xFD 12: v128.const, 16 bytes of immediate
CHEAP = (bytes(16), b'\xff' * 16)


def hoist_body(m, k, min_uses):
    """(new body bytes, constants hoisted) of defined function k."""
    b = m.bodies[k]
    params = len(m.ftype(m.imported_funcs + k)[0])
    n, i = uleb(b, 0)
    groups, declared = [], 0
    for _ in range(n):
        count, i = uleb(b, i)
        groups.append((count, b[i]))
        declared += count
        i += 1
    start = i
    uses = collections.Counter()
    for at, op, sub, imm, nxt in instructions(b, start, len(b)):
        if op == 0xFD and sub == V128_CONST:
            uses[b[imm:imm + 16]] += 1
    chosen = [v for v, c in uses.items() if c >= min_uses and v not in CHEAP]
    if not chosen:
        return b, 0
    local = {v: params + declared + j for j, v in enumerate(sorted(chosen))}
    out = bytearray(enc_u(len(groups) + 1))
    for count, t in groups:
        out += enc_u(count) + bytes([t])
    out += enc_u(len(chosen)) + bytes([V128])
    for v, index in sorted(local.items(), key=lambda x: x[1]):
        out += b'\xfd' + enc_u(V128_CONST) + v + b'\x21' + enc_u(index)  # v128.const; local.set
    last = start
    for at, op, sub, imm, nxt in instructions(b, start, len(b)):
        if op == 0xFD and sub == V128_CONST and b[imm:imm + 16] in local:
            out += b[last:at] + b'\x20' + enc_u(local[b[imm:imm + 16]])  # local.get
            last = nxt
    out += b[last:]
    return bytes(out), len(chosen)


def hoist(src, dst, min_uses=2):
    m = Module(Path(src).read_bytes())
    bodies, functions, constants = [], 0, 0
    for k in range(len(m.bodies)):
        body, hoisted = hoist_body(m, k, min_uses)
        bodies.append(body)
        functions += bool(hoisted)
        constants += hoisted
    code = m.section(10)
    code[1] = enc_u(len(bodies)) + b''.join(enc_u(len(body)) + body for body in bodies)
    Path(dst).write_bytes(m.encode())
    return functions, constants


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input')
    ap.add_argument('output')
    ap.add_argument('--min-uses', type=int, default=2)
    a = ap.parse_args()
    functions, constants = hoist(a.input, a.output, a.min_uses)
    print('hoist_consts: %d constants into locals in %d functions' % (constants, functions))


if __name__ == '__main__':
    main()
