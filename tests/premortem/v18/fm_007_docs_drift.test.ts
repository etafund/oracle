import { describe, expect, test } from "vitest";

import { V18_BUNDLE_VERSION } from "@src/oracle/v18/index.ts";
import {
  PROVIDER_DOCS_SNAPSHOT_SCHEMA_VERSION,
  evaluateProviderDocsFreshness,
  preflightProviderDocs,
  providerDocsBlockEnvelopeIfStale,
  providerDocsSnapshotSchema,
} from "@src/oracle/v18/provider_docs.ts";
import {
  CAPABILITY_LEASE_SCHEMA_VERSION,
  consumeCapabilityLease,
  issueCapabilityLease,
} from "@src/oracle/v18/capability_lease.ts";
import { premortemForId } from "@tests/_helpers/premortem.ts";

const FM = premortemForId("FM-007")!;
const NOW = new Date("2026-05-12T12:00:00Z");

function buildSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bundle_version: V18_BUNDLE_VERSION,
    checked_at: "2026-05-12T00:00:00Z",
    expiration_policy: "Re-check before implementation and before any live audit run.",
    expires_at: "2026-06-11T00:00:00Z",
    implementation_rule: "Bundle contracts must encode current highest-effort defaults.",
    max_age_days: 30,
    refresh_required_before_live_provider_calls: true,
    schema_version: PROVIDER_DOCS_SNAPSHOT_SCHEMA_VERSION,
    sources: [
      { provider: "chatgpt", relevant_claim: "Pro labels may drift", url: "https://example.invalid/pro" },
    ],
    ...overrides,
  };
}

describe(`premortem ${FM.id}: ${FM.title}`, () => {
  test("documents which Oracle acceptance checks this file covers", () => {
    expect(FM.oracle_acceptance_checks.length).toBeGreaterThan(0);
  });

  test("fresh snapshot passes the live-call preflight", () => {
    expect(preflightProviderDocs(buildSnapshot(), { now: NOW })).toBeNull();
  });

  test("stale snapshot with refresh_required=true blocks live calls", () => {
    const envelope = preflightProviderDocs(
      buildSnapshot({
        checked_at: "2026-04-01T00:00:00Z",
        expires_at: "2026-05-01T00:00:00Z", // expired
      }),
      { now: NOW, meta: { run_id: "run-fm007" } },
    );
    expect(envelope).not.toBeNull();
    expect(envelope!.ok).toBe(false);
    expect(envelope!.blocked_reason).toBe("provider_docs_stale");
    expect(envelope!.next_command).toBe("oracle docs refresh --json");
  });

  test("wrong schema_version on docs snapshot is rejected", () => {
    expect(() =>
      providerDocsSnapshotSchema.parse(
        buildSnapshot({ schema_version: "provider_docs_snapshot.v0" }),
      ),
    ).toThrow();
  });

  test("stale by max_age_days flags ui_drift_suspected", () => {
    // 31 days after checked_at, but expires_at still in the future.
    const verdict = evaluateProviderDocsFreshness(
      buildSnapshot({
        checked_at: "2026-04-11T00:00:00Z",
        expires_at: "2026-05-13T00:00:00Z",
      }),
      NOW,
    );
    expect(verdict.fresh).toBe(false);
    expect(
      verdict.reasons.find((r) => r.field === "provider_docs_snapshot.max_age_days")?.code,
    ).toBe("ui_drift_suspected");
  });

  test("fresh capability lease is consumable inside its TTL", () => {
    const lease = issueCapabilityLease({
      lease_id: "lease-fm007",
      provider: "chatgpt",
      capability: "pro_extended_reasoning",
      issued_at: NOW.toISOString(),
      ttlSeconds: 1800,
    });
    expect(lease.schema_version).toBe(CAPABILITY_LEASE_SCHEMA_VERSION);
    const result = consumeCapabilityLease(
      lease,
      { capability: "pro_extended_reasoning", provider: "chatgpt" },
      new Date(NOW.getTime() + 60_000),
    );
    expect(result.consumed).toBe(true);
  });

  test("expired capability lease forces provider_login_required", () => {
    const lease = issueCapabilityLease({
      lease_id: "lease-fm007-expired",
      provider: "chatgpt",
      capability: "pro_extended_reasoning",
      issued_at: NOW.toISOString(),
      ttlSeconds: 60,
    });
    const result = consumeCapabilityLease(
      lease,
      { capability: "pro_extended_reasoning", provider: "chatgpt" },
      new Date(NOW.getTime() + 3_600_000), // 1h later
    );
    expect(result.consumed).toBe(false);
    expect(
      result.reasons.find(
        (r) => r.field === "capability_lease.expires_at",
      )?.code,
    ).toBe("provider_login_required");
  });

  test("stale-only blocking envelope passes the v18 json_envelope contract", () => {
    const verdict = evaluateProviderDocsFreshness(
      buildSnapshot({ expires_at: "2026-05-01T00:00:00Z" }),
      NOW,
    );
    const env = providerDocsBlockEnvelopeIfStale(verdict, { run_id: "run-fm007" });
    expect(env).not.toBeNull();
    expect(env!.errors.length).toBeGreaterThan(0);
    // Each error carries a v18 error_code; we only inspect strings here.
    for (const entry of env!.errors) {
      const code = (entry as Record<string, unknown>).error_code;
      expect(typeof code).toBe("string");
    }
  });
});
