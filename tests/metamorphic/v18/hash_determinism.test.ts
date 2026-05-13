// Metamorphic relation #3: hash determinism + non-collision under
// canonical equivalence.
//
//   ∀ bytes b:                       sha256(b) call₁ = sha256(b) call₂
//   ∀ logically-equal objects a, b:  sha256(canonical(a)) = sha256(canonical(b))
//   ∀ logically-distinct objects:    sha256(canonical(a)) ≠ sha256(canonical(b))
//   ∀ pretty-print of object x:      sha256(JSON.stringify(x, …, 2))
//                                       ≠ sha256(canonical(x))   (whitespace matters)
//   ∀ valid hash h:                  assertRealHash(h) returns h unchanged
//   ∀ placeholder h:                 assertRealHash(h) throws

import { describe, expect, it } from "vitest";

import {
  assertRealHash,
  canonicalJSON,
  isPlaceholderHash,
  sha256OfBytes,
} from "../../../src/oracle/v18/index.js";

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed | 0 || 1;
  }
  next(): number {
    let x = this.state | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x | 0;
    return ((x >>> 0) % 0xffffffff) / 0xffffffff;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)] as T;
  }
  bool(prob = 0.5): boolean {
    return this.next() < prob;
  }
}

function arbitraryObject(rng: Rng, depth = 0): unknown {
  if (depth >= 3 || rng.bool(0.25)) {
    const variant = rng.int(0, 4);
    if (variant === 0) return rng.int(-1_000_000, 1_000_000);
    if (variant === 1) return rng.bool();
    if (variant === 2) return null;
    if (variant === 3) return `v_${rng.int(0, 1_000_000).toString(36)}`;
    return Array.from({ length: rng.int(0, 4) }, () => rng.int(0, 100));
  }
  const out: Record<string, unknown> = {};
  const n = rng.int(2, 6);
  for (let i = 0; i < n; i += 1) {
    out[`k_${rng.int(0, 100_000).toString(36)}_${i}`] = arbitraryObject(rng, depth + 1);
  }
  return out;
}

function shuffleObjectKeysDeep(value: unknown, rng: Rng): unknown {
  if (Array.isArray(value)) return value.map((v) => shuffleObjectKeysDeep(v, rng));
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    for (let i = keys.length - 1; i > 0; i -= 1) {
      const j = rng.int(0, i);
      [keys[i], keys[j]] = [keys[j] as string, keys[i] as string];
    }
    const out: Record<string, unknown> = {};
    for (const k of keys)
      out[k] = shuffleObjectKeysDeep((value as Record<string, unknown>)[k], rng);
    return out;
  }
  return value;
}

const ITERATIONS = 200;
const BASE_SEED = 0x5eed5;

describe("Metamorphic: hash determinism + canonical-equivalence non-collision", () => {
  describe("sha256OfBytes", () => {
    it(`is deterministic across repeated calls (${ITERATIONS} iters)`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + i;
        const rng = new Rng(seed);
        const len = rng.int(0, 4096);
        const bytes = new Uint8Array(len);
        for (let k = 0; k < len; k += 1) bytes[k] = rng.int(0, 255);
        const a = sha256OfBytes(bytes);
        const b = sha256OfBytes(bytes);
        expect(a, `seed=${seed}`).toBe(b);
        expect(a, `seed=${seed}`).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    });

    it(`agrees between Uint8Array and string inputs for utf-8 strings`, () => {
      for (let i = 0; i < 50; i += 1) {
        const seed = BASE_SEED + 10_000 + i;
        const rng = new Rng(seed);
        const s = `chunk-${rng.int(0, 1_000_000)}-${rng.int(0, 1_000_000)}`;
        const fromString = sha256OfBytes(s);
        const fromBytes = sha256OfBytes(new TextEncoder().encode(s));
        expect(fromBytes, `seed=${seed}`).toBe(fromString);
      }
    });
  });

  describe("canonicalJSON", () => {
    it(`is invariant under top-level + nested key permutation (${ITERATIONS} iters)`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 20_000 + i;
        const rng = new Rng(seed);
        const obj = arbitraryObject(rng);
        const shuffled = shuffleObjectKeysDeep(obj, rng);
        expect(canonicalJSON(shuffled), `seed=${seed}`).toBe(canonicalJSON(obj));
      }
    });

    it(`feeds sha256 to identical digest under permutation`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 30_000 + i;
        const rng = new Rng(seed);
        const obj = arbitraryObject(rng);
        const shuffled = shuffleObjectKeysDeep(obj, rng);
        const a = sha256OfBytes(canonicalJSON(obj));
        const b = sha256OfBytes(canonicalJSON(shuffled));
        expect(a, `seed=${seed}`).toBe(b);
      }
    });
  });

  describe("non-collision: logically distinct inputs hash differently", () => {
    it(`(${ITERATIONS} iters)`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 40_000 + i;
        const rng = new Rng(seed);
        const obj = arbitraryObject(rng);
        // Create a guaranteed-distinct twin by injecting a unique key.
        const twin = { ...(obj as Record<string, unknown>), _twin_marker: rng.int(0, 1_000_000) };
        const a = sha256OfBytes(canonicalJSON(obj));
        const b = sha256OfBytes(canonicalJSON(twin));
        expect(a, `seed=${seed}: collision`).not.toBe(b);
      }
    });
  });

  describe("whitespace-vs-canonical: byte-level inputs must hash differently", () => {
    it(`pretty-printed JSON has a DIFFERENT hash than canonicalJSON for the same object`, () => {
      // The hasher operates on bytes — so adding spaces / newlines is
      // observable. If a future refactor swapped sha256OfBytes(s) for
      // sha256OfBytes(canonicalJSON(JSON.parse(s))), this property
      // would flip and the evidence ledger would falsely accept pretty
      // input as canonical.
      for (let i = 0; i < 50; i += 1) {
        const seed = BASE_SEED + 50_000 + i;
        const rng = new Rng(seed);
        const obj = arbitraryObject(rng);
        const canon = canonicalJSON(obj);
        const pretty = JSON.stringify(obj, null, 2);
        if (canon === pretty) continue; // tiny scalars can collide trivially
        expect(sha256OfBytes(pretty), `seed=${seed}`).not.toBe(sha256OfBytes(canon));
      }
    });
  });

  describe("assertRealHash + isPlaceholderHash", () => {
    it(`accepts every real-shaped hash produced by sha256OfBytes`, () => {
      for (let i = 0; i < 50; i += 1) {
        const seed = BASE_SEED + 60_000 + i;
        const rng = new Rng(seed);
        const len = rng.int(1, 1024);
        const bytes = new Uint8Array(len);
        for (let k = 0; k < len; k += 1) bytes[k] = rng.int(0, 255);
        const h = sha256OfBytes(bytes);
        expect(isPlaceholderHash(h), `seed=${seed}: real hash flagged as placeholder`).toBe(false);
        // assertRealHash echoes the hash unchanged when it accepts it.
        expect(assertRealHash(h, "test_field"), `seed=${seed}`).toBe(h);
      }
    });

    it(`rejects any all-same-hex-char placeholder (any of 16 hex chars)`, () => {
      for (const c of "0123456789abcdef") {
        const placeholder = `sha256:${c.repeat(64)}`;
        expect(isPlaceholderHash(placeholder), `char=${c}`).toBe(true);
        expect(() => assertRealHash(placeholder, "test")).toThrow();
      }
    });
  });
});
