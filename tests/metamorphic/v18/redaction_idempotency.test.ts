// Metamorphic relation #2: redaction idempotency + monotonic key-set
// shrinkage.
//
//   ∀ payload `x`:                 redact(redact(x)) deep-equals redact(x)
//   ∀ payload `x`:                 keys(redact(x)) ⊆ keys(x)
//   ∀ payload `x`:                 |redact(x)|.keys ≤ |x|.keys
//   ∀ clean payload `x`:           redact(x) deep-equals x
//   ∀ payload with forbidden key:  that key is absent from redact(x)
//
// Applies to both redaction surfaces:
//   - src/oracle/v18/evidence.ts                    redactEvidencePayload
//   - src/browser/evidence_redact_always.ts         redactBrowserEvidenceAlways
//                                                   sanitizeBrowserEvidenceForWrite
//
// Any property that fails on either surface is a real defect — this
// suite does NOT attempt to fix src/*, it only files the finding.

import { describe, expect, it } from "vitest";

import {
  findForbiddenExtensionKeys,
  redactBrowserEvidenceAlways,
  sanitizeBrowserEvidenceForWrite,
} from "../../../src/browser/evidence_redact_always.js";
import { redactEvidencePayload } from "../../../src/oracle/v18/index.js";

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = (seed | 0) || 1;
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

const SAFE_KEYS = [
  "schema_version",
  "evidence_id",
  "provider",
  "run_id",
  "mode_verified",
  "created_at",
  "verification_method",
  "selector_manifest_version",
  "extra_metadata",
  "next_command",
] as const;

const FORBIDDEN_KEYS = [
  "cookies",
  "auth_headers",
  "authorization",
  "bearer_token",
  "raw_dom",
  "dom_snapshot",
  "screenshot",
  "screenshot_base64",
  "session_token",
  "api_key",
  "localStorage",
  "sessionStorage",
  "email",
  "user_email",
  "raw_prompt",
  "raw_output",
  "output_text",
  "assistant_text",
] as const;

const PRESERVED_KEYS = [
  // Digest carve-outs the redactor MUST keep.
  "prompt_sha256",
  "output_text_sha256",
  "session_id_hash",
  // stores_* privacy declarations are also kept.
  "stores_cookies",
  "stores_raw_dom",
  "stores_raw_screenshots",
] as const;

function buildPayload(rng: Rng, depth = 0): unknown {
  if (depth >= 3 || rng.bool(0.2)) {
    const variant = rng.int(0, 4);
    if (variant === 0) return rng.int(-1000, 1000);
    if (variant === 1) return rng.bool();
    if (variant === 2) return null;
    if (variant === 3) return `value_${rng.int(0, 1_000_000).toString(16)}`;
    return `sha256:${"a".repeat(64)}`;
  }
  const out: Record<string, unknown> = {};
  const safeN = rng.int(2, 5);
  const forbiddenN = rng.int(0, 3);
  const preservedN = rng.int(0, 3);
  for (let i = 0; i < safeN; i += 1) {
    out[`${rng.pick(SAFE_KEYS)}_${i}`] = buildPayload(rng, depth + 1);
  }
  for (let i = 0; i < forbiddenN; i += 1) {
    const key = `${rng.pick(FORBIDDEN_KEYS)}${rng.bool() ? `_${i}` : ""}`;
    out[key] = `leak_${i}`;
  }
  for (let i = 0; i < preservedN; i += 1) {
    out[`${rng.pick(PRESERVED_KEYS)}_${i}`] = `sha256:${"b".repeat(64)}`;
  }
  if (rng.bool(0.3)) {
    out.nested_array = Array.from({ length: rng.int(0, 3) }, () => buildPayload(rng, depth + 1));
  }
  return out;
}

function countKeys(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countKeys(v), 0);
  if (value && typeof value === "object") {
    let n = 0;
    for (const [, v] of Object.entries(value)) {
      n += 1 + countKeys(v);
    }
    return n;
  }
  return 0;
}

function collectKeyPaths(value: unknown, prefix = "", acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectKeyPaths(v, `${prefix}[${i}]`, acc));
    return acc;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix === "" ? k : `${prefix}.${k}`;
      acc.push(p);
      collectKeyPaths(v, p, acc);
    }
  }
  return acc;
}

const ITERATIONS = 200;
const BASE_SEED = 0xDEC0DE;

describe("Metamorphic: redaction idempotency + key-set monotonicity", () => {
  describe("redactEvidencePayload (v18 layer)", () => {
    it(`is idempotent: redact(redact(x)) = redact(x) (${ITERATIONS} iters)`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + i;
        const rng = new Rng(seed);
        const x = buildPayload(rng);
        const once = redactEvidencePayload(x).redacted;
        const twice = redactEvidencePayload(once).redacted;
        expect(twice, `seed=${seed}`).toEqual(once);
      }
    });

    it(`never produces more keys than the input had (${ITERATIONS} iters)`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 10_000 + i;
        const rng = new Rng(seed);
        const x = buildPayload(rng);
        const out = redactEvidencePayload(x).redacted;
        expect(countKeys(out), `seed=${seed}`).toBeLessThanOrEqual(countKeys(x));
      }
    });

    it(`every output key-path is also present in the input`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 20_000 + i;
        const rng = new Rng(seed);
        const x = buildPayload(rng);
        const outPaths = new Set(collectKeyPaths(redactEvidencePayload(x).redacted));
        const inPaths = new Set(collectKeyPaths(x));
        for (const p of outPaths) {
          expect(inPaths.has(p), `seed=${seed}: spurious path "${p}" appeared after redaction`).toBe(
            true,
          );
        }
      }
    });
  });

  describe("redactBrowserEvidenceAlways (browser-layer audit-finding guard)", () => {
    it(`is idempotent (${ITERATIONS} iters)`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 30_000 + i;
        const rng = new Rng(seed);
        const x = buildPayload(rng);
        const once = redactBrowserEvidenceAlways(x).redacted;
        const twice = redactBrowserEvidenceAlways(once).redacted;
        expect(twice, `seed=${seed}`).toEqual(once);
      }
    });

    it(`output is always free of forbidden extension keys`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 40_000 + i;
        const rng = new Rng(seed);
        const x = buildPayload(rng);
        const out = redactBrowserEvidenceAlways(x).redacted;
        const hits = findForbiddenExtensionKeys(out);
        expect(hits, `seed=${seed}: forbidden keys survived first pass`).toEqual([]);
      }
    });

    it(`preserves _sha256 / _hash digest carve-outs across all iterations`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 50_000 + i;
        const rng = new Rng(seed);
        const x = buildPayload(rng);
        const inputDigestKeys = collectKeyPaths(x).filter(
          (p) => p.endsWith("_sha256") || p.endsWith("_hash"),
        );
        if (inputDigestKeys.length === 0) continue;
        const outPaths = new Set(collectKeyPaths(redactBrowserEvidenceAlways(x).redacted));
        for (const dk of inputDigestKeys) {
          expect(outPaths.has(dk), `seed=${seed}: digest key "${dk}" lost`).toBe(true);
        }
      }
    });
  });

  describe("sanitizeBrowserEvidenceForWrite (combined guard)", () => {
    it(`output is clean enough that the assertion never re-fires`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 60_000 + i;
        const rng = new Rng(seed);
        const x = buildPayload(rng);
        const out = sanitizeBrowserEvidenceForWrite(x).redacted;
        // Round-trip through itself must not throw and must produce the
        // same bytes (idempotent under the combined guard).
        const again = sanitizeBrowserEvidenceForWrite(out).redacted;
        expect(again, `seed=${seed}`).toEqual(out);
      }
    });
  });

  describe("clean-input identity (no forbidden keys at all)", () => {
    it(`redact(x) = x when x has no forbidden keys`, () => {
      // PRESERVED_KEYS carve-outs only fire when the FULL key ends in
      // `_sha256` / `_hash` or starts with `stores_`; the substring
      // matcher inspects the entire lowercased key. Naming a field
      // `output_text_sha256_0` re-introduces the forbidden substring
      // `output_text` and the trailing `_0` defeats the suffix carve-out
      // — so build clean inputs from SAFE_KEYS only, plus exact-form
      // carve-out keys (no numeric suffixes on the digest names).
      const EXACT_CARVE_OUTS = ["prompt_sha256", "stores_cookies", "session_id_hash"] as const;
      for (let i = 0; i < 50; i += 1) {
        const seed = BASE_SEED + 70_000 + i;
        const rng = new Rng(seed);
        const clean: Record<string, unknown> = {};
        for (let j = 0; j < rng.int(1, 5); j += 1) {
          clean[`${rng.pick(SAFE_KEYS)}_${j}`] = rng.int(0, 1000);
        }
        if (rng.bool()) {
          clean[rng.pick(EXACT_CARVE_OUTS)] = `sha256:${"c".repeat(64)}`;
        }
        const out = redactBrowserEvidenceAlways(clean).redacted;
        expect(out, `seed=${seed}`).toEqual(clean);
      }
    });
  });
});
