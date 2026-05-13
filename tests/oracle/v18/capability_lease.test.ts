import { describe, expect, test } from "vitest";

import { V18_BUNDLE_VERSION } from "@src/oracle/v18/contracts.ts";
import {
  CAPABILITY_LEASE_SCHEMA_VERSION,
  capabilityLeaseSchema,
  consumeCapabilityLease,
  evaluateCapabilityLease,
  issueCapabilityLease,
} from "@src/oracle/v18/capability_lease.ts";

const NOW = new Date("2026-05-12T00:10:00Z");

function buildLease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bundle_version: V18_BUNDLE_VERSION,
    capability: "pro_extended_reasoning",
    expires_at: "2026-05-12T00:30:00Z", // 20 minutes after NOW
    issued_at: "2026-05-12T00:00:00Z",
    lease_id: "lease-test-001",
    provider: "chatgpt",
    same_session_required: true,
    schema_version: CAPABILITY_LEASE_SCHEMA_VERSION,
    status: "active",
    verification_method: "oracle-browser-doctor",
    ...overrides,
  };
}

describe("capabilityLeaseSchema", () => {
  test("accepts the canonical fixture shape", () => {
    expect(() => capabilityLeaseSchema.parse(buildLease())).not.toThrow();
  });

  test("rejects wrong schema_version", () => {
    expect(() =>
      capabilityLeaseSchema.parse(buildLease({ schema_version: "capability_lease.v0" })),
    ).toThrow();
  });

  test("rejects unknown status value", () => {
    expect(() => capabilityLeaseSchema.parse(buildLease({ status: "pending" }))).toThrow();
  });
});

describe("evaluateCapabilityLease", () => {
  test("active lease inside its TTL is fresh", () => {
    const verdict = evaluateCapabilityLease(buildLease(), NOW);
    expect(verdict.fresh).toBe(true);
    expect(verdict.status).toBe("fresh");
    expect(verdict.expiresInMs).toBeGreaterThan(0);
  });

  test("expired lease (status=expired) is rejected with provider_login_required", () => {
    const verdict = evaluateCapabilityLease(
      buildLease({
        status: "expired",
        expires_at: "2026-05-12T00:05:00Z", // already past
      }),
      NOW,
    );
    expect(verdict.fresh).toBe(false);
    expect(verdict.status).toBe("expired");
    // Both reasons (status + expires_at) should reference provider_login_required.
    expect(
      verdict.reasons.some(
        (r) => r.field === "capability_lease.status" && r.code === "provider_login_required",
      ),
    ).toBe(true);
  });

  test("expires_at in the past flags the lease as expired even when status=active", () => {
    const verdict = evaluateCapabilityLease(
      buildLease({ expires_at: "2026-05-12T00:05:00Z" }),
      NOW,
    );
    expect(verdict.fresh).toBe(false);
    expect(verdict.status).toBe("expired");
    expect(
      verdict.reasons.find((r) => r.field === "capability_lease.expires_at")?.code,
    ).toBe("provider_login_required");
  });

  test("status=revoked surfaces with inactive status", () => {
    const verdict = evaluateCapabilityLease(buildLease({ status: "revoked" }), NOW);
    expect(verdict.fresh).toBe(false);
    expect(verdict.status).toBe("inactive");
  });

  test("malformed payload returns status=invalid", () => {
    const verdict = evaluateCapabilityLease({ schema_version: "bogus" }, NOW);
    expect(verdict.fresh).toBe(false);
    expect(verdict.status).toBe("invalid");
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });
});

describe("consumeCapabilityLease — fresh leases skip the probe", () => {
  test("fresh matching lease is consumed inside its TTL", () => {
    const result = consumeCapabilityLease(
      buildLease(),
      { capability: "pro_extended_reasoning", provider: "chatgpt" },
      NOW,
    );
    expect(result.consumed).toBe(true);
    expect(result.lease).not.toBeNull();
    expect(result.lease!.capability).toBe("pro_extended_reasoning");
    expect(result.lease!.provider).toBe("chatgpt");
    expect(result.reasons).toEqual([]);
  });

  test("expired lease is NOT consumed (forces re-probe)", () => {
    const result = consumeCapabilityLease(
      buildLease({ expires_at: "2026-05-12T00:05:00Z" }),
      { capability: "pro_extended_reasoning", provider: "chatgpt" },
      NOW,
    );
    expect(result.consumed).toBe(false);
    expect(result.lease).toBeNull();
    expect(
      result.reasons.find((r) => r.field === "capability_lease.expires_at")?.code,
    ).toBe("provider_login_required");
  });

  test("capability mismatch is rejected", () => {
    const result = consumeCapabilityLease(
      buildLease(),
      { capability: "deep_think_high", provider: "chatgpt" },
      NOW,
    );
    expect(result.consumed).toBe(false);
    expect(
      result.reasons.some((r) => r.field === "capability_lease.capability"),
    ).toBe(true);
  });

  test("provider mismatch is rejected", () => {
    const result = consumeCapabilityLease(
      buildLease(),
      { capability: "pro_extended_reasoning", provider: "gemini" },
      NOW,
    );
    expect(result.consumed).toBe(false);
    expect(
      result.reasons.some((r) => r.field === "capability_lease.provider"),
    ).toBe(true);
  });

  test("requireSameSession=true is satisfied when lease enforces it", () => {
    const result = consumeCapabilityLease(
      buildLease({ same_session_required: true }),
      {
        capability: "pro_extended_reasoning",
        provider: "chatgpt",
        requireSameSession: true,
      },
      NOW,
    );
    expect(result.consumed).toBe(true);
  });

  test("requireSameSession=true rejects a lease that does not enforce same-session", () => {
    const result = consumeCapabilityLease(
      buildLease({ same_session_required: false }),
      {
        capability: "pro_extended_reasoning",
        provider: "chatgpt",
        requireSameSession: true,
      },
      NOW,
    );
    expect(result.consumed).toBe(false);
    const reason = result.reasons.find(
      (r) => r.field === "capability_lease.same_session_required",
    );
    expect(reason?.code).toBe("prompt_submitted_before_verification");
  });

  test("malformed lease blocks consumption (forces re-probe)", () => {
    const result = consumeCapabilityLease(
      { schema_version: "wrong" },
      { capability: "pro_extended_reasoning", provider: "chatgpt" },
      NOW,
    );
    expect(result.consumed).toBe(false);
    expect(result.lease).toBeNull();
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe("issueCapabilityLease", () => {
  test("computes expires_at from issued_at + ttlSeconds", () => {
    const lease = issueCapabilityLease({
      lease_id: "lease-issued-1",
      provider: "chatgpt",
      capability: "pro_extended_reasoning",
      issued_at: "2026-05-12T00:00:00Z",
      ttlSeconds: 1800, // 30 min
      verification_method: "oracle-browser-doctor",
      same_session_required: true,
    });
    expect(lease.schema_version).toBe(CAPABILITY_LEASE_SCHEMA_VERSION);
    expect(lease.status).toBe("active");
    expect(lease.expires_at).toBe("2026-05-12T00:30:00.000Z");
    expect(lease.verification_method).toBe("oracle-browser-doctor");
    expect(lease.same_session_required).toBe(true);
  });

  test("rejects negative or NaN TTLs", () => {
    expect(() =>
      issueCapabilityLease({
        lease_id: "x",
        provider: "chatgpt",
        capability: "x",
        issued_at: "2026-05-12T00:00:00Z",
        ttlSeconds: 0,
      }),
    ).toThrow(/ttlSeconds/);
    expect(() =>
      issueCapabilityLease({
        lease_id: "x",
        provider: "chatgpt",
        capability: "x",
        issued_at: "2026-05-12T00:00:00Z",
        ttlSeconds: Number.NaN,
      }),
    ).toThrow(/ttlSeconds/);
  });

  test("rejects malformed issued_at", () => {
    expect(() =>
      issueCapabilityLease({
        lease_id: "x",
        provider: "chatgpt",
        capability: "x",
        issued_at: "not-a-date",
        ttlSeconds: 60,
      }),
    ).toThrow(/issued_at/);
  });

  test("issued lease is freshly consumable through consumeCapabilityLease", () => {
    const issuedAt = new Date(NOW.getTime() - 60_000).toISOString();
    const lease = issueCapabilityLease({
      lease_id: "lease-round-trip-1",
      provider: "gemini",
      capability: "deep_think_high",
      issued_at: issuedAt,
      ttlSeconds: 1800,
    });
    const result = consumeCapabilityLease(
      lease,
      { capability: "deep_think_high", provider: "gemini" },
      NOW,
    );
    expect(result.consumed).toBe(true);
    expect(result.lease?.lease_id).toBe("lease-round-trip-1");
  });
});
