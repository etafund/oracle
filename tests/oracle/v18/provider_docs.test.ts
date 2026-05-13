import { describe, expect, test } from "vitest";

import { V18_BUNDLE_VERSION } from "@src/oracle/v18/contracts.ts";
import {
  PROVIDER_DOCS_SNAPSHOT_SCHEMA_VERSION,
  evaluateProviderDocsFreshness,
  preflightProviderDocs,
  providerDocsBlockEnvelopeIfStale,
  providerDocsSnapshotSchema,
} from "@src/oracle/v18/provider_docs.ts";

const NOW = new Date("2026-05-12T12:00:00Z");

function buildSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: PROVIDER_DOCS_SNAPSHOT_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    checked_at: "2026-05-12T00:00:00Z",
    expires_at: "2026-06-11T00:00:00Z",
    expiration_policy:
      "Re-check before implementation and before any live audit run; these docs are current-planning inputs.",
    implementation_rule:
      "Bundle contracts must encode current highest-effort defaults; providers must capability-probe before treating a result as synthesis-eligible.",
    max_age_days: 30,
    refresh_required_before_live_provider_calls: true,
    sources: [
      {
        provider: "chatgpt",
        relevant_claim: "Pro picker labels may drift; verify in same session.",
        url: "https://help.openai.com/en/articles/6825453-chatgpt-release-notes",
      },
    ],
    ...overrides,
  };
}

describe("providerDocsSnapshotSchema", () => {
  test("accepts the canonical fixture shape", () => {
    expect(() => providerDocsSnapshotSchema.parse(buildSnapshot())).not.toThrow();
  });

  test("rejects wrong schema_version", () => {
    expect(() =>
      providerDocsSnapshotSchema.parse(buildSnapshot({ schema_version: "wrong.v1" })),
    ).toThrow();
  });

  test("rejects max_age_days < 1", () => {
    expect(() => providerDocsSnapshotSchema.parse(buildSnapshot({ max_age_days: 0 }))).toThrow();
  });
});

describe("evaluateProviderDocsFreshness", () => {
  test("fresh snapshot 12h after checked_at, before expiry, returns fresh", () => {
    const verdict = evaluateProviderDocsFreshness(buildSnapshot(), NOW);
    expect(verdict.fresh).toBe(true);
    expect(verdict.status).toBe("fresh");
    expect(verdict.reasons).toEqual([]);
    expect(verdict.ageMs).toBeCloseTo(12 * 3600 * 1000, -1);
    expect(verdict.expiresInMs).toBeGreaterThan(0);
  });

  test("stale by max_age_days flags ui_drift_suspected", () => {
    // checked_at is 31d before NOW; max_age_days=30.
    const verdict = evaluateProviderDocsFreshness(
      buildSnapshot({
        checked_at: "2026-04-11T00:00:00Z",
        expires_at: "2026-05-13T00:00:00Z", // still in the future
      }),
      NOW,
    );
    expect(verdict.fresh).toBe(false);
    expect(verdict.status).toBe("stale_age");
    const reason = verdict.reasons.find(
      (r) => r.field === "provider_docs_snapshot.max_age_days",
    );
    expect(reason?.code).toBe("ui_drift_suspected");
  });

  test("expired by expires_at flags status=expired", () => {
    const verdict = evaluateProviderDocsFreshness(
      buildSnapshot({
        checked_at: "2026-05-11T00:00:00Z",
        expires_at: "2026-05-12T00:00:00Z", // expired 12h before NOW
      }),
      NOW,
    );
    expect(verdict.fresh).toBe(false);
    expect(verdict.status).toBe("expired");
    expect(verdict.expiresInMs).toBeLessThan(0);
    expect(
      verdict.reasons.find((r) => r.field === "provider_docs_snapshot.expires_at")?.code,
    ).toBe("ui_drift_suspected");
  });

  test("malformed payload returns status=invalid with schema reasons", () => {
    const verdict = evaluateProviderDocsFreshness({ schema_version: "wrong" }, NOW);
    expect(verdict.fresh).toBe(false);
    expect(verdict.status).toBe("invalid");
    expect(verdict.reasons.length).toBeGreaterThan(0);
    expect(verdict.refreshRequiredBeforeLiveProviderCalls).toBe(true);
  });

  test("malformed timestamps surface explicit reasons", () => {
    const verdict = evaluateProviderDocsFreshness(
      buildSnapshot({ checked_at: "not-a-date", expires_at: "also-bad" }),
      NOW,
    );
    expect(verdict.fresh).toBe(false);
    const fields = verdict.reasons.map((r) => r.field);
    expect(fields).toContain("provider_docs_snapshot.checked_at");
    expect(fields).toContain("provider_docs_snapshot.expires_at");
  });
});

describe("providerDocsBlockEnvelopeIfStale", () => {
  test("fresh verdict returns null (no block)", () => {
    const verdict = evaluateProviderDocsFreshness(buildSnapshot(), NOW);
    expect(providerDocsBlockEnvelopeIfStale(verdict)).toBeNull();
  });

  test("stale verdict with refresh_required=true returns a v18 blocked envelope", () => {
    const verdict = evaluateProviderDocsFreshness(
      buildSnapshot({
        checked_at: "2026-04-01T00:00:00Z",
        expires_at: "2026-05-01T00:00:00Z",
      }),
      NOW,
    );
    const envelope = providerDocsBlockEnvelopeIfStale(verdict, { run_id: "run-test" });
    expect(envelope).not.toBeNull();
    expect(envelope!.ok).toBe(false);
    expect(envelope!.schema_version).toBe("json_envelope.v1");
    expect(envelope!.blocked_reason).toBe("provider_docs_stale");
    expect(envelope!.next_command).toBe("oracle docs refresh --json");
    expect(envelope!.fix_command).toBe("oracle docs refresh --json");
    expect(envelope!.retry_safe).toBe(true);
    expect(envelope!.meta.run_id).toBe("run-test");
    expect(envelope!.meta.bundle_version).toBe(V18_BUNDLE_VERSION);
    expect(envelope!.errors.length).toBeGreaterThan(0);
    // Every error must carry a v18 error_code.
    for (const entry of envelope!.errors) {
      const code = (entry as Record<string, unknown>).error_code;
      expect(typeof code).toBe("string");
    }
  });

  test("stale verdict with refresh_required=false stays a warning (no envelope)", () => {
    const verdict = evaluateProviderDocsFreshness(
      buildSnapshot({
        checked_at: "2026-04-01T00:00:00Z",
        expires_at: "2026-05-01T00:00:00Z",
        refresh_required_before_live_provider_calls: false,
      }),
      NOW,
    );
    expect(verdict.fresh).toBe(false);
    expect(verdict.refreshRequiredBeforeLiveProviderCalls).toBe(false);
    expect(providerDocsBlockEnvelopeIfStale(verdict)).toBeNull();
  });
});

describe("preflightProviderDocs (one-shot helper)", () => {
  test("returns null for a fresh snapshot", () => {
    expect(preflightProviderDocs(buildSnapshot(), { now: NOW })).toBeNull();
  });

  test("returns a blocked envelope for an expired refresh-required snapshot", () => {
    const env = preflightProviderDocs(
      buildSnapshot({
        checked_at: "2026-04-01T00:00:00Z",
        expires_at: "2026-05-01T00:00:00Z",
      }),
      { now: NOW, meta: { run_id: "run-x" } },
    );
    expect(env).not.toBeNull();
    expect(env!.blocked_reason).toBe("provider_docs_stale");
  });
});
