import { describe, expect, test } from "vitest";

import {
  CAPABILITY_LEASE_SCHEMA_VERSION,
  consumeCapabilityLease,
  evaluateCapabilityLease,
} from "@src/oracle/v18/capability_lease.ts";
import {
  RECONNECT_NEVER_CLICK_ANSWER_NOW,
  applyReconnectEvent,
  decideReconnect,
  defaultReconnectPolicy,
  initialRemoteRunState,
} from "@src/remote/reconnect.ts";
import { buildHeartbeat, heartbeatToLogLine } from "@src/remote/heartbeat.ts";
import { V18_BUNDLE_VERSION } from "@src/oracle/v18/index.ts";
import { premortemForId } from "@tests/_helpers/premortem.ts";

const FM = premortemForId("FM-002")!;
const NOW = new Date("2026-05-12T00:10:00Z");

function buildLease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bundle_version: V18_BUNDLE_VERSION,
    capability: "pro_extended_reasoning",
    expires_at: "2026-05-12T00:30:00Z",
    issued_at: "2026-05-12T00:00:00Z",
    lease_id: "lease-fm002",
    provider: "chatgpt",
    same_session_required: true,
    schema_version: CAPABILITY_LEASE_SCHEMA_VERSION,
    status: "active",
    verification_method: "oracle-browser-doctor",
    ...overrides,
  };
}

describe(`premortem ${FM.id}: ${FM.title}`, () => {
  test("documents which Oracle acceptance checks this file covers", () => {
    expect(FM.oracle_acceptance_checks.length).toBeGreaterThan(0);
  });

  test("the AGENTS.md never-click-Answer-now invariant is exported and true", () => {
    expect(RECONNECT_NEVER_CLICK_ANSWER_NOW).toBe(true);
  });

  test("stale lease (status=expired) cannot be consumed without re-probing", () => {
    const result = consumeCapabilityLease(
      buildLease({ status: "expired", expires_at: "2026-05-12T00:05:00Z" }),
      { capability: "pro_extended_reasoning", provider: "chatgpt" },
      NOW,
    );
    expect(result.consumed).toBe(false);
    expect(result.lease).toBeNull();
    // Map to the right v18 error code so the recover surface is machine-readable.
    expect(result.reasons.some((r) => r.code === "provider_login_required")).toBe(true);
  });

  test("lease expires_at in the past flips eligibility even when status=active", () => {
    const verdict = evaluateCapabilityLease(
      buildLease({ expires_at: "2026-05-12T00:05:00Z" }),
      NOW,
    );
    expect(verdict.fresh).toBe(false);
    expect(verdict.status).toBe("expired");
  });

  test("reconnect attempts back off and eventually hand off via oracle session <id>", () => {
    const policy = {
      ...defaultReconnectPolicy(),
      maxAttempts: 2,
      initialBackoffMs: 1_000,
      maxBackoffMs: 8_000,
      heartbeatMissDeadlineMs: 60_000,
    };
    let state = initialRemoteRunState({ sessionId: "sess-fm002", startedAtMs: 1_700_000_000_000 });
    // Two target-lost / recovered cycles drain the attempt budget.
    for (let i = 0; i < policy.maxAttempts; i += 1) {
      state = applyReconnectEvent(state, {
        type: "target_lost",
        at: 1_700_000_000_000 + i * 1_000,
      });
      state = applyReconnectEvent(state, {
        type: "target_recovered",
        at: 1_700_000_000_000 + i * 1_000 + 500,
      });
    }
    state = applyReconnectEvent(state, {
      type: "target_lost",
      at: 1_700_000_000_000 + 10_000,
    });
    const decision = decideReconnect(state, 1_700_000_000_000 + 11_000, policy);
    expect(decision.kind).toBe("background");
    if (decision.kind === "background") {
      expect(decision.recoverCommand).toBe("oracle session sess-fm002");
      // Confirm the decision never advises clicking Answer now.
      expect(decision.reason).not.toMatch(/Answer now/i);
    }
  });

  test("heartbeat output for a background hand-off carries the recover command and no reasoning text", () => {
    const state = initialRemoteRunState({
      sessionId: "sess-fm002",
      startedAtMs: 1_700_000_000_000,
    });
    const decision = decideReconnect(
      state,
      1_700_000_000_000 + defaultReconnectPolicy().maxTotalWaitMs + 1,
      defaultReconnectPolicy(),
    );
    const heartbeat = buildHeartbeat({ state, decision, now: 1_700_000_000_000 + 10_000 });
    const line = heartbeatToLogLine(heartbeat);
    expect(heartbeat.recover_command).toBe("oracle session sess-fm002");
    expect(heartbeat.state).toBe("background");
    expect(line).not.toMatch(/raw_output|assistant_text|authorization|Bearer sk-/i);
  });
});
