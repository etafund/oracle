import { describe, expect, test } from "vitest";
import { V18_BUNDLE_VERSION } from "../../src/oracle/v18/index.js";
import { buildOracleVisibilityStatus } from "../../src/oracle/visibility.js";
import {
  formatStatusVisibility,
  runStatusVisibility,
} from "../../src/cli/commands/statusVisibility.js";

const NOW = new Date("2026-05-13T00:00:00.000Z");

function budget(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "runtime_budget.v1",
    profile: "balanced",
    max_cost_usd: 10,
    max_wall_minutes: 60,
    required_approvals: ["live_fanout"],
    ...overrides,
  };
}

function waiver(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "fallback_waiver.v1",
    bundle_version: V18_BUNDLE_VERSION,
    waiver_id: "waiver-status-1",
    profile: "balanced",
    scope: "provider_slot",
    provider_slot: "chatgpt_pro_first_plan",
    allowed_degradation: "skip_optional_reviewer",
    non_waivable_slots: ["chatgpt_pro_first_plan", "chatgpt_pro_synthesis", "gemini_deep_think"],
    reason: "status fixture",
    created_by: "apr",
    created_at: "2026-05-13T00:00:00.000Z",
    expires_at: "2026-05-14T00:00:00.000Z",
    user_acknowledged: true,
    must_surface_in_handoff: true,
    synthesis_eligible_after_waiver: true,
    ...overrides,
  };
}

const coveredPremortem = [
  { id: "FM-006", title: "Opaque waiting", status: "covered" as const },
  { id: "FM-010", title: "Waiver loopholes", status: "covered" as const },
];

describe("oracle visibility status", () => {
  test("aggregates runtime budget, waiver, and premortem state into a ready envelope", () => {
    const result = buildOracleVisibilityStatus({
      profile: "balanced",
      slot: "chatgpt_pro_first_plan",
      now: NOW,
      budget: {
        budget: budget(),
        approvalsPresent: ["live_fanout"],
        consumedWallMs: 10 * 60 * 1000,
        consumedCostUsd: 1,
      },
      premortem: coveredPremortem,
    });

    expect(result.envelope).toMatchObject({
      schema_version: "json_envelope.v1",
      ok: true,
      blocked_reason: null,
      data: {
        schema_version: "oracle_visibility_status.v1",
        status: "ready",
        budget: {
          present: true,
          approvals: { missing: [], satisfied: true },
        },
        waiver: {
          waiver_attempted: false,
          non_waivable_slot: true,
        },
        premortem: {
          total: 2,
          covered: 2,
          missing: 0,
        },
      },
    });
    expect(result.payload.budget.estimate?.max_wall_seconds).toBe(3600);
  });

  test("blocks when runtime budget approvals are missing", () => {
    const result = buildOracleVisibilityStatus({
      profile: "balanced",
      slot: "chatgpt_pro_first_plan",
      now: NOW,
      budget: { budget: budget(), approvalsPresent: [] },
      premortem: coveredPremortem,
    });

    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.blocked_reason).toBe("runtime_budget_approval_missing");
    expect(result.envelope.next_command).toBe("oracle preview --json");
    expect(result.payload.components[0]).toMatchObject({
      name: "runtime_budget",
      status: "fail",
      code: "runtime_budget_approval_missing",
    });
  });

  test("surfaces non-waivable waiver attempts as visible blockers", () => {
    const result = buildOracleVisibilityStatus({
      profile: "balanced",
      slot: "chatgpt_pro_first_plan",
      now: NOW,
      budget: { budget: budget(), approvalsPresent: ["live_fanout"] },
      waiver: waiver(),
      premortem: coveredPremortem,
    });

    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.blocked_reason).toBe("waiver_non_waivable_slot");
    expect(result.payload.waiver).toMatchObject({
      waiver_attempted: true,
      waiver_applicable: false,
      must_surface_in_handoff: true,
      non_waivable_slot: true,
    });
  });

  test("blocks missing premortem failure-mode coverage with a release-gate command", () => {
    const result = buildOracleVisibilityStatus({
      profile: "balanced",
      slot: "xai_grok_reasoning",
      now: NOW,
      budget: { budget: budget(), approvalsPresent: ["live_fanout"] },
      premortem: [
        { id: "FM-006", status: "covered" },
        { id: "FM-010", status: "missing" },
      ],
    });

    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.blocked_reason).toBe("premortem_coverage_missing");
    expect(result.envelope.next_command).toBe("rch exec -- pnpm vitest run tests/premortem/v18");
    expect(result.payload.premortem).toMatchObject({ total: 2, covered: 1, missing: 1 });
  });

  test("JSON command output is deterministic enough for robots", async () => {
    const output: string[] = [];
    const result = await runStatusVisibility(
      {
        profile: "balanced",
        slot: "chatgpt_pro_first_plan",
        now: NOW,
        json: true,
        budget: { budget: budget(), approvalsPresent: ["live_fanout"] },
        premortem: coveredPremortem,
      },
      { stdout: (text) => output.push(text) },
    );

    expect(result.envelope.ok).toBe(true);
    expect(JSON.parse(output[0])).toMatchObject({
      ok: true,
      data: { schema_version: "oracle_visibility_status.v1" },
      meta: { generated_at: "2026-05-13T00:00:00.000Z" },
    });
  });

  test("text output includes recovery hints for blocked states", () => {
    const result = buildOracleVisibilityStatus({
      profile: "balanced",
      slot: "chatgpt_pro_first_plan",
      now: NOW,
      budget: { budget: budget({ schema_version: "runtime_budget.v0" }) },
      premortem: coveredPremortem,
    });

    const text = formatStatusVisibility(result);
    expect(text).toContain("oracle visibility status: blocked");
    expect(text).toContain("runtime_budget.v1 payload is invalid");
    expect(text).toContain("Fix: Provide a valid runtime_budget.v1 payload.");
  });
});
