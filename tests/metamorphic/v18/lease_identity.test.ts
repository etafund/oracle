// Metamorphic relation #4: capability-lease acquire/release identity.
//
//   ∀ valid issue input I:                  consume(issue(I), {cap, provider}) = consumed=true
//                                           with lease.capability=I.capability ∧
//                                                lease.provider=I.provider
//   ∀ issued lease L, time t > L.expires_at: evaluate(L, t) = fresh=false
//   ∀ mismatched (cap, provider) request:    consume = consumed=false
//   ∀ requireSameSession=true, lease without flag: consume = consumed=false
//   ∀ valid I: schema parse round-trips L through JSON.parse(JSON.stringify(L))
//
// The "release" half of the metamorphic identity is the natural
// expiry: after expires_at the same lease must not consume. We don't
// have an explicit release() (capability leases are time-bounded), so
// the relation is acquire-then-time-advance ≡ release.

import { describe, expect, it } from "vitest";

// capability_lease helpers are not re-exported through ./index.js; reach
// for the module directly. (Barrel-export gap, not a contract defect —
// the module itself works and is the canonical home of issue/consume.)
import {
  capabilityLeaseSchema,
  consumeCapabilityLease,
  evaluateCapabilityLease,
  issueCapabilityLease,
} from "../../../src/oracle/v18/capability_lease.js";
import { V18_ERROR_CODES } from "../../../src/oracle/v18/index.js";

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

const PROVIDERS = ["chatgpt", "gemini", "claude", "synthetic_robot"] as const;
const CAPABILITIES = [
  "pro_extended_reasoning",
  "deep_think",
  "deep_research",
  "browser_attach",
  "pro_long_run",
] as const;
const METHODS = [
  "same_session_ui_observation_plus_selector_trace",
  "cdp_target_assertion",
  "synthetic_test",
] as const;

interface IssueArgs {
  lease_id: string;
  provider: string;
  capability: string;
  issued_at: string;
  ttlSeconds: number;
  verification_method?: string;
  same_session_required?: boolean;
}

function arbitraryIssueInput(rng: Rng): IssueArgs {
  return {
    lease_id: `lease-${rng.int(0, 1_000_000).toString(16)}`,
    provider: rng.pick(PROVIDERS),
    capability: rng.pick(CAPABILITIES),
    issued_at: new Date(1_700_000_000_000 + rng.int(0, 1_000_000_000)).toISOString(),
    ttlSeconds: rng.int(30, 7200),
    ...(rng.bool() ? { verification_method: rng.pick(METHODS) } : {}),
    ...(rng.bool() ? { same_session_required: true } : {}),
  };
}

const ITERATIONS = 200;
const BASE_SEED = 0x1ea5e;

describe("Metamorphic: capability_lease acquire/release identity", () => {
  it(`issue → consume happy path: consumed=true with matching cap+provider (${ITERATIONS} iters)`, () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = BASE_SEED + i;
      const rng = new Rng(seed);
      const args = arbitraryIssueInput(rng);
      const lease = issueCapabilityLease(args);
      const now = new Date(Date.parse(args.issued_at) + Math.floor(args.ttlSeconds * 1000 * 0.5));
      const result = consumeCapabilityLease(
        lease,
        { capability: args.capability, provider: args.provider },
        now,
      );
      expect(
        result.consumed,
        `seed=${seed}: matching request rejected\n${JSON.stringify(result.reasons)}`,
      ).toBe(true);
      expect(result.lease, `seed=${seed}`).not.toBeNull();
      expect(result.lease?.capability, `seed=${seed}`).toBe(args.capability);
      expect(result.lease?.provider, `seed=${seed}`).toBe(args.provider);
    }
  });

  it(`evaluate after expires_at: fresh=false (${ITERATIONS} iters)`, () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = BASE_SEED + 10_000 + i;
      const rng = new Rng(seed);
      const args = arbitraryIssueInput(rng);
      const lease = issueCapabilityLease(args);
      const afterExpiry = new Date(Date.parse(args.issued_at) + args.ttlSeconds * 1000 + 1);
      const freshness = evaluateCapabilityLease(lease, afterExpiry);
      expect(freshness.fresh, `seed=${seed}: lease still fresh past expiry`).toBe(false);
    }
  });

  it(`consume rejects mismatched capability (${ITERATIONS} iters)`, () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = BASE_SEED + 20_000 + i;
      const rng = new Rng(seed);
      const args = arbitraryIssueInput(rng);
      const lease = issueCapabilityLease(args);
      // Force a different capability.
      const otherCaps = CAPABILITIES.filter((c) => c !== args.capability);
      if (otherCaps.length === 0) continue;
      const wrongCap = rng.pick(otherCaps);
      const result = consumeCapabilityLease(
        lease,
        { capability: wrongCap, provider: args.provider },
        new Date(Date.parse(args.issued_at) + 1000),
      );
      expect(result.consumed, `seed=${seed}: wrong cap accepted`).toBe(false);
    }
  });

  it(`consume rejects mismatched provider (${ITERATIONS} iters)`, () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = BASE_SEED + 30_000 + i;
      const rng = new Rng(seed);
      const args = arbitraryIssueInput(rng);
      const lease = issueCapabilityLease(args);
      const otherProvs = PROVIDERS.filter((p) => p !== args.provider);
      if (otherProvs.length === 0) continue;
      const wrongProv = rng.pick(otherProvs);
      const result = consumeCapabilityLease(
        lease,
        { capability: args.capability, provider: wrongProv },
        new Date(Date.parse(args.issued_at) + 1000),
      );
      expect(result.consumed, `seed=${seed}: wrong provider accepted`).toBe(false);
    }
  });

  it(`requireSameSession=true rejects a lease without that flag`, () => {
    for (let i = 0; i < 100; i += 1) {
      const seed = BASE_SEED + 40_000 + i;
      const rng = new Rng(seed);
      const args = { ...arbitraryIssueInput(rng), same_session_required: false } as IssueArgs;
      delete args.same_session_required;
      const lease = issueCapabilityLease(args);
      const result = consumeCapabilityLease(
        lease,
        {
          capability: args.capability,
          provider: args.provider,
          requireSameSession: true,
        },
        new Date(Date.parse(args.issued_at) + 1000),
      );
      expect(result.consumed, `seed=${seed}: weak lease consumed under requireSameSession`).toBe(
        false,
      );
      const codes = result.reasons.map((r) => r.code);
      expect(codes, `seed=${seed}`).toContain("prompt_submitted_before_verification");
    }
  });

  it(`requireSameSession=true accepts a lease that enforces it`, () => {
    for (let i = 0; i < 100; i += 1) {
      const seed = BASE_SEED + 50_000 + i;
      const rng = new Rng(seed);
      const args = { ...arbitraryIssueInput(rng), same_session_required: true };
      const lease = issueCapabilityLease(args);
      const result = consumeCapabilityLease(
        lease,
        {
          capability: args.capability,
          provider: args.provider,
          requireSameSession: true,
        },
        new Date(Date.parse(args.issued_at) + 1000),
      );
      expect(result.consumed, `seed=${seed}`).toBe(true);
    }
  });

  it(`schema round-trip: parse(JSON.parse(JSON.stringify(lease))) ≅ lease`, () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = BASE_SEED + 60_000 + i;
      const rng = new Rng(seed);
      const args = arbitraryIssueInput(rng);
      const lease = issueCapabilityLease(args);
      const reparsed = capabilityLeaseSchema.parse(JSON.parse(JSON.stringify(lease)));
      expect(reparsed, `seed=${seed}`).toEqual(lease);
    }
  });

  it(`every reason code emitted by consume is in the v18 taxonomy or null`, () => {
    const taxonomy: ReadonlySet<string> = new Set(V18_ERROR_CODES);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = BASE_SEED + 70_000 + i;
      const rng = new Rng(seed);
      const args = arbitraryIssueInput(rng);
      const lease = issueCapabilityLease(args);
      const otherProvs = PROVIDERS.filter((p) => p !== args.provider);
      if (otherProvs.length === 0) continue;
      const result = consumeCapabilityLease(
        lease,
        { capability: args.capability, provider: rng.pick(otherProvs) },
        new Date(Date.parse(args.issued_at) + 1000),
      );
      for (const r of result.reasons) {
        expect(
          r.code === null || taxonomy.has(r.code),
          `seed=${seed}: non-taxonomy code ${String(r.code)}`,
        ).toBe(true);
      }
    }
  });
});
