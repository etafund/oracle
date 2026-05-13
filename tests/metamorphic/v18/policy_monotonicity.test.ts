// Metamorphic relation #5: policy decision monotonicity under
// tightening + extension-key irrelevance.
//
//   ∀ inputs i, capability `c`:
//     evaluateProviderApiAllowed(c with api_allowed=true) eligible
//        ⟹ evaluateProviderApiAllowed(c with api_allowed=false) NOT eligible
//
//   ∀ result r blocked by evaluateSynthesisGate(args):
//     evaluateSynthesisGate(args ∪ {arbitrary extension keys on r}) is ALSO blocked
//     (extension keys never flip core decisions — strict-core /
//      permissive-extension policy)
//
//   ∀ result r eligible for synthesis when evidence is NOT required:
//     when evidenceRequired=true and evidence_id/evidence are missing,
//     synthesis is blocked (tightening one knob is strictly stronger)
//
//   ∀ capability c with status="blocked":
//     evaluateProviderApiAllowed(c) is blocked regardless of api_allowed
//
//   ∀ api access_path on result + capability.api_allowed=false:
//     evaluateApiSubstitution is blocked

import { describe, expect, it } from "vitest";

import {
  PROVIDER_CAPABILITY_SCHEMA_VERSION,
  PROVIDER_RESULT_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  evaluateApiSubstitution,
  evaluateProviderApiAllowed,
  evaluateProviderResultSynthesisEligibility,
  evaluateSynthesisGate,
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

const REAL_HASH = (label: string): string =>
  `sha256:${(label.repeat(64) + "0".repeat(64)).slice(0, 64)}`;

interface CapInput {
  schema_version: typeof PROVIDER_CAPABILITY_SCHEMA_VERSION;
  provider: string;
  capabilities: Record<string, unknown>;
  checked_at: string;
  status?: "ready" | "blocked" | "degraded" | "unknown";
  api_allowed?: boolean;
  evidence_required?: boolean;
  [k: string]: unknown;
}

interface ResultInput {
  schema_version: typeof PROVIDER_RESULT_SCHEMA_VERSION;
  bundle_version: typeof V18_BUNDLE_VERSION;
  provider_slot: string;
  provider_family: string;
  access_path: string;
  status: "success" | "failed" | "degraded" | "skipped" | "manual_import" | "cached";
  synthesis_eligible: boolean;
  evidence: Record<string, unknown> | null;
  evidence_id: string | null;
  prompt_manifest_sha256: string;
  source_baseline_sha256: string;
  provider_result_id: string;
  result_text_sha256: string;
  [k: string]: unknown;
}

function arbitraryCapability(rng: Rng): CapInput {
  return {
    schema_version: PROVIDER_CAPABILITY_SCHEMA_VERSION,
    provider: rng.pick(["chatgpt", "gemini", "claude"]),
    capabilities: { effort_picker: true },
    checked_at: new Date(1_700_000_000_000 + rng.int(0, 1_000_000_000)).toISOString(),
    status: rng.pick(["ready", "degraded", "unknown"] as const),
    api_allowed: rng.bool(),
  };
}

function arbitraryResult(
  rng: Rng,
  opts: { syntheticAccessPath?: "api" | "browser" } = {},
): ResultInput {
  const accessPath =
    opts.syntheticAccessPath === "api"
      ? "api_official"
      : opts.syntheticAccessPath === "browser"
        ? "browser_attach"
        : rng.pick(["api_official", "browser_attach", "stdin_paste"] as const);
  return {
    schema_version: PROVIDER_RESULT_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    provider_slot: rng.pick(["chatgpt_pro_first_plan", "gemini_deep_think_first", "claude_opus"]),
    provider_family: rng.pick(["chatgpt", "gemini", "claude"]),
    access_path: accessPath,
    status: "success",
    synthesis_eligible: true,
    evidence: { evidence_id: "ev-1" },
    evidence_id: "ev-1",
    prompt_manifest_sha256: REAL_HASH("a"),
    source_baseline_sha256: REAL_HASH("b"),
    provider_result_id: `pr-${rng.int(0, 1_000_000).toString(36)}`,
    result_text_sha256: REAL_HASH("c"),
  };
}

function withExtensions(obj: Record<string, unknown>, rng: Rng): Record<string, unknown> {
  const out = { ...obj };
  const n = rng.int(1, 4);
  for (let i = 0; i < n; i += 1) {
    const key = `ext_unknown_${rng.int(0, 1_000_000).toString(36)}_${i}`;
    out[key] = rng.bool() ? rng.int(0, 1000) : `payload_${i}`;
  }
  return out;
}

const ITERATIONS = 200;
const BASE_SEED = 0xbeef;

describe("Metamorphic: policy decision monotonicity (strict-core/permissive-extension)", () => {
  describe("evaluateProviderApiAllowed — tightening api_allowed never expands eligibility", () => {
    it(`api_allowed=true eligible ⟹ api_allowed=false rejected (${ITERATIONS} iters)`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + i;
        const rng = new Rng(seed);
        const baseline = {
          ...arbitraryCapability(rng),
          api_allowed: true,
          status: "ready" as const,
        };
        const allowed = evaluateProviderApiAllowed(baseline);
        if (!allowed.eligible) continue; // not a valid baseline for this property
        const tightened = { ...baseline, api_allowed: false };
        const after = evaluateProviderApiAllowed(tightened);
        expect(after.eligible, `seed=${seed}: api_allowed=false became eligible`).toBe(false);
      }
    });

    it(`status=blocked is always rejected regardless of api_allowed`, () => {
      for (let i = 0; i < 100; i += 1) {
        const seed = BASE_SEED + 10_000 + i;
        const rng = new Rng(seed);
        for (const api of [true, false]) {
          const cap = {
            ...arbitraryCapability(rng),
            api_allowed: api,
            status: "blocked" as const,
          };
          const verdict = evaluateProviderApiAllowed(cap);
          expect(verdict.eligible, `seed=${seed} api=${api}`).toBe(false);
        }
      }
    });
  });

  describe("evaluateApiSubstitution — api access_path + api_allowed=false is rejected", () => {
    it(`(${ITERATIONS} iters)`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 20_000 + i;
        const rng = new Rng(seed);
        const capability = {
          ...arbitraryCapability(rng),
          api_allowed: false,
          status: "ready" as const,
        };
        const result = arbitraryResult(rng, { syntheticAccessPath: "api" });
        const verdict = evaluateApiSubstitution({ capability, result });
        expect(verdict.eligible, `seed=${seed}`).toBe(false);
      }
    });

    it(`api_allowed=true with api access_path stays eligible (control)`, () => {
      for (let i = 0; i < 100; i += 1) {
        const seed = BASE_SEED + 25_000 + i;
        const rng = new Rng(seed);
        const capability = {
          ...arbitraryCapability(rng),
          api_allowed: true,
          status: "ready" as const,
        };
        const result = arbitraryResult(rng, { syntheticAccessPath: "api" });
        const verdict = evaluateApiSubstitution({ capability, result });
        expect(verdict.eligible, `seed=${seed}`).toBe(true);
      }
    });
  });

  describe("evaluateProviderResultSynthesisEligibility — tightening evidenceRequired", () => {
    it(`eligible without evidenceRequired stays eligible WITH it ONLY IF evidence is present`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 30_000 + i;
        const rng = new Rng(seed);
        const result = arbitraryResult(rng);
        // Tightening: same result, but require evidence. Result has
        // evidence/evidence_id set, so verdict should stay eligible.
        const a = evaluateProviderResultSynthesisEligibility(result);
        const b = evaluateProviderResultSynthesisEligibility(result, { evidenceRequired: true });
        if (a.eligible) {
          expect(b.eligible, `seed=${seed}: with evidence present, tighten still eligible`).toBe(
            true,
          );
        }
      }
    });

    it(`stripping evidence under evidenceRequired causes rejection (monotone tightening)`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 40_000 + i;
        const rng = new Rng(seed);
        const stripped: ResultInput = {
          ...arbitraryResult(rng),
          evidence: null,
          evidence_id: null,
        };
        const a = evaluateProviderResultSynthesisEligibility(stripped);
        // Without evidenceRequired, a is whatever the core synthesis_eligible says (true here).
        expect(a.eligible, `seed=${seed}: without evidenceRequired baseline`).toBe(true);
        const b = evaluateProviderResultSynthesisEligibility(stripped, { evidenceRequired: true });
        expect(b.eligible, `seed=${seed}: tightened`).toBe(false);
      }
    });
  });

  describe("extension-key irrelevance — strict-core/permissive-extension", () => {
    it(`adding random extension keys to a blocked result does NOT make it eligible`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 50_000 + i;
        const rng = new Rng(seed);
        // Force a blocked result: synthesis_eligible=false.
        const result: ResultInput = { ...arbitraryResult(rng), synthesis_eligible: false };
        const before = evaluateProviderResultSynthesisEligibility(result);
        expect(before.eligible, `seed=${seed}: setup`).toBe(false);
        const polluted = withExtensions(result as Record<string, unknown>, rng);
        const after = evaluateProviderResultSynthesisEligibility(polluted);
        expect(after.eligible, `seed=${seed}: extensions flipped decision`).toBe(false);
      }
    });

    it(`adding random extension keys to a capability never flips api_allowed=false → true`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 60_000 + i;
        const rng = new Rng(seed);
        const cap: CapInput = {
          ...arbitraryCapability(rng),
          api_allowed: false,
          status: "ready",
        };
        const polluted = withExtensions(cap as Record<string, unknown>, rng);
        const verdict = evaluateProviderApiAllowed(polluted);
        expect(verdict.eligible, `seed=${seed}: extensions bypassed api_allowed`).toBe(false);
      }
    });

    it(`evaluateSynthesisGate reasons never shrink when extensions are added (strict-core)`, () => {
      for (let i = 0; i < ITERATIONS; i += 1) {
        const seed = BASE_SEED + 70_000 + i;
        const rng = new Rng(seed);
        // A blocked result with explicit fail conditions.
        const result: ResultInput = {
          ...arbitraryResult(rng),
          synthesis_eligible: false,
          status: "failed",
        };
        const baselineReasons = evaluateSynthesisGate({ result }).blockedReasons.length;
        const polluted = withExtensions(result as Record<string, unknown>, rng);
        const pollutedReasons = evaluateSynthesisGate({ result: polluted }).blockedReasons.length;
        expect(
          pollutedReasons,
          `seed=${seed}: reasons shrank under extension`,
        ).toBeGreaterThanOrEqual(baselineReasons);
      }
    });
  });
});
