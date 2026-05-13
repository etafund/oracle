// Metamorphic relation #1: round-trip identity for json_envelope.v1.
//
//   ∀ valid envelope `e`:  parse(JSON.parse(JSON.stringify(e))) ≅ e
//   ∀ permutation of `e`'s top-level keys: canonical(...) is invariant
//   ∀ extension key `k` on `e`: schema.parse preserves `k`
//
// Generators run a seeded PRNG so failures are reproducible — the
// seed is logged in any assertion message that fires.
//
// fast-check is not installed in this repo; an in-process seeded
// generator covers the same property-based-testing shape and keeps
// the change scope confined to tests/.

import { describe, expect, it } from "vitest";

import {
  JSON_ENVELOPE_SCHEMA_VERSION,
  V18_ERROR_CODES,
  createEnvelope,
  createErrorEnvelope,
  jsonEnvelopeSchema,
  jsonEnvelopeStrictSchema,
  type JsonEnvelope,
  type V18ErrorCode,
} from "../../../src/oracle/v18/index.js";

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = (seed | 0) || 1;
  }
  // xorshift32 — deterministic, fast, no deps.
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
  word(min = 3, max = 10): string {
    const len = this.int(min, max);
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789_";
    let s = "";
    for (let i = 0; i < len; i += 1) s += chars[this.int(0, chars.length - 1)];
    return s;
  }
}

function arbitraryExtension(rng: Rng, count: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) {
    const key = `ext_${rng.word()}_${i}`;
    const variant = rng.int(0, 3);
    if (variant === 0) out[key] = rng.word();
    else if (variant === 1) out[key] = rng.int(-1000, 1000);
    else if (variant === 2) out[key] = rng.bool();
    else out[key] = { nested: rng.word() };
  }
  return out;
}

function arbitrarySuccessEnvelope(rng: Rng): JsonEnvelope {
  const ext = arbitraryExtension(rng, rng.int(0, 3));
  return createEnvelope(
    {
      ok: true,
      data: rng.bool() ? { key: rng.word(), n: rng.int(0, 100) } : null,
      meta: { run_id: rng.word(), iteration: rng.int(0, 1000) },
      warnings: rng.bool() ? [rng.word()] : [],
      commands: rng.bool() ? { next: rng.word() } : {},
    },
    ext,
  );
}

function arbitraryFailureEnvelope(rng: Rng): JsonEnvelope {
  const codes: V18ErrorCode[] = [];
  const n = rng.int(1, 3);
  for (let i = 0; i < n; i += 1) codes.push(rng.pick(V18_ERROR_CODES));
  type ErrorEntry = { error_code: V18ErrorCode; message: string; details?: Record<string, unknown> };
  const entries: ErrorEntry[] = codes.map((c) => ({
    error_code: c,
    message: `synthetic failure: ${c}`,
    details: rng.bool() ? { iter: rng.int(0, 100) } : undefined,
  }));
  return createErrorEnvelope(
    {
      errors: entries as [ErrorEntry, ...ErrorEntry[]],
      meta: { run_id: rng.word() },
      next_command: rng.bool() ? `oracle ${rng.word()}` : null,
      fix_command: rng.bool() ? `oracle ${rng.word()} --fix` : null,
      retry_safe: rng.bool(),
    },
    arbitraryExtension(rng, rng.int(0, 2)),
  );
}

function shuffleKeys(obj: Record<string, unknown>, rng: Rng): Record<string, unknown> {
  const keys = Object.keys(obj);
  for (let i = keys.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [keys[i], keys[j]] = [keys[j] as string, keys[i] as string];
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

const ITERATIONS = 200;
const BASE_SEED = 0xC0FFEE;

describe("Metamorphic: json_envelope.v1 round-trip identity", () => {
  it(`success arm: parse(JSON.parse(JSON.stringify(e))) ≅ e (${ITERATIONS} iterations)`, () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = BASE_SEED + i;
      const rng = new Rng(seed);
      const envelope = arbitrarySuccessEnvelope(rng);
      const reparsed = jsonEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));
      expect(reparsed, `seed=${seed}`).toEqual(envelope);
    }
  });

  it(`failure arm: parse(JSON.parse(JSON.stringify(e))) ≅ e (${ITERATIONS} iterations)`, () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = BASE_SEED + 10_000 + i;
      const rng = new Rng(seed);
      const envelope = arbitraryFailureEnvelope(rng);
      const reparsed = jsonEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));
      expect(reparsed, `seed=${seed}`).toEqual(envelope);
    }
  });

  it(`failure arm: every generated failure satisfies the strict refinement`, () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = BASE_SEED + 20_000 + i;
      const rng = new Rng(seed);
      const envelope = arbitraryFailureEnvelope(rng);
      const result = jsonEnvelopeStrictSchema.safeParse(envelope);
      expect(result.success, `seed=${seed}: strict parse failed`).toBe(true);
    }
  });

  it(`top-level key permutation is invariant under parse (canonical equivalence)`, () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = BASE_SEED + 30_000 + i;
      const rng = new Rng(seed);
      const envelope = arbitrarySuccessEnvelope(rng);
      const shuffled = shuffleKeys(envelope as Record<string, unknown>, rng);
      const a = jsonEnvelopeSchema.parse(envelope);
      const b = jsonEnvelopeSchema.parse(shuffled);
      expect(b, `seed=${seed}`).toEqual(a);
    }
  });

  it(`extension keys survive a full parse round-trip (passthrough policy)`, () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = BASE_SEED + 40_000 + i;
      const rng = new Rng(seed);
      const ext = arbitraryExtension(rng, 5);
      const envelope = createEnvelope(
        {
          ok: true,
          data: null,
          meta: { run: "ext-rt" },
        },
        ext,
      );
      const reparsed = jsonEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));
      for (const [k, v] of Object.entries(ext)) {
        expect((reparsed as Record<string, unknown>)[k], `seed=${seed}: extension "${k}"`).toEqual(
          v,
        );
      }
    }
  });

  it(`schema_version literal is preserved on every round-trip`, () => {
    for (let i = 0; i < 50; i += 1) {
      const seed = BASE_SEED + 50_000 + i;
      const rng = new Rng(seed);
      const envelope = rng.bool() ? arbitrarySuccessEnvelope(rng) : arbitraryFailureEnvelope(rng);
      expect(envelope.schema_version, `seed=${seed}`).toBe(JSON_ENVELOPE_SCHEMA_VERSION);
      const reparsed = jsonEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));
      expect(reparsed.schema_version, `seed=${seed}`).toBe(JSON_ENVELOPE_SCHEMA_VERSION);
    }
  });
});
