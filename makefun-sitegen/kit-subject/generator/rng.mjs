// rng.mjs — plain-JS port of the kit's program/generator/rng.ts (xoshiro128** stream).
// Types stripped by hand; semantics identical (Math.imul + 32-bit shifts only).
// Used ONLY to draw fresh fuzz/bench case sets on the fleet (node22 cannot run .ts).
import { createHash } from 'node:crypto';

export const RNG_DOMAIN = 'makefun/speed-home/rng/v1';

const rotl = (x, k) => (x << k) | (x >>> (32 - k));

export class Rng {
  #a;
  #b;
  #c;
  #d;

  constructor(key) {
    const v = new DataView(key.buffer, key.byteOffset, 16);
    this.#a = v.getUint32(0) | 0;
    this.#b = v.getUint32(4) | 0;
    this.#c = v.getUint32(8) | 0;
    this.#d = v.getUint32(12) | 0;
    if ((this.#a | this.#b | this.#c | this.#d) === 0) throw new RangeError('an all-zero xoshiro128** state never moves');
  }

  u32() {
    const a = this.#a;
    const b = this.#b;
    const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    let c = this.#c ^ a;
    let d = this.#d ^ b;
    const nb = b ^ c;
    const na = a ^ d;
    c ^= t;
    d = rotl(d, 11);
    this.#a = na;
    this.#b = nb;
    this.#c = c;
    this.#d = d;
    return result;
  }

  int(lo, hi) {
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi < lo || hi - lo >= 2 ** 32) throw new RangeError(`int(${lo}, ${hi}): two whole numbers, lo <= hi, under 2^32 apart`);
    const span = hi - lo + 1;
    if (span === 2 ** 32) return lo + this.u32();
    const limit = Math.floor(2 ** 32 / span) * span;
    let x = this.u32();
    while (x >= limit) x = this.u32();
    return lo + (x % span);
  }

  float() {
    return this.u32() / 2 ** 32;
  }

  pick(xs) {
    if (xs.length === 0) throw new RangeError('pick: an empty array');
    return xs[this.int(0, xs.length - 1)];
  }

  chance(p) {
    return this.float() < p;
  }
}

export function streamFor(seed, label, index) {
  const key = createHash('sha256').update(`${RNG_DOMAIN}\n${seed}\n${label}\n${index}`).digest();
  return new Rng(key);
}
