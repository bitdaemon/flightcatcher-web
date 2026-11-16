// SplitMix64: small, fast, fully deterministic. Same seed gives the same sequence on every machine.
const MASK = (1n << 64n) - 1n;

export class SeededRNG {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = seed & MASK;
  }

  next(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return z ^ (z >> 31n);
  }

  /** Uniform in [0, 1). */
  unit(): number {
    return Number(this.next() >> 11n) / 2 ** 53;
  }

  /** Uniform integer in [0, n). */
  below(n: number): number {
    if (n <= 0) return 0;
    return Number(this.next() % BigInt(n));
  }
}

export function randomSeed(): bigint {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  const s = (BigInt(a[0]) << 32n) | BigInt(a[1]);
  return s === 0n ? 1n : s;
}
