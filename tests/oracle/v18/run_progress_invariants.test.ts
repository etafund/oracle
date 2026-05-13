import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  RUN_PROGRESS_SCHEMA_VERSION,
  RUN_PROGRESS_STATE_VALUES,
  V18_BUNDLE_VERSION,
  runProgressSchema,
} from "@src/oracle/v18/index.ts";
import {
  RUN_PROGRESS_STATES,
  buildRunProgressEvent,
  progressPercentFromElapsed,
} from "@src/oracle/v18/run_progress.ts";

function validRunProgress(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: RUN_PROGRESS_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    run_id: "run-test",
    profile: "balanced",
    state: "running",
    current_stage: "first_plan",
    completed_stages: ["brief_lint"],
    pending_stages: ["synthesis"],
    progress_percent: 50,
    user_visible_message: "Run is in progress.",
    next_command: null,
    blocked_reason: null,
    retry_safe: true,
    ...overrides,
  };
}

describe("run_progress.v1 schema invariants", () => {
  test("rejects unknown states", () => {
    const parsed = runProgressSchema.safeParse(validRunProgress({ state: "nonsense" }));
    expect(parsed.success).toBe(false);
  });

  test.each([-1, 101, 10.5, Number.POSITIVE_INFINITY])(
    "rejects invalid progress_percent=%s",
    (progress_percent) => {
      const parsed = runProgressSchema.safeParse(validRunProgress({ progress_percent }));
      expect(parsed.success).toBe(false);
    },
  );

  test("accepts every helper state value", () => {
    expect(RUN_PROGRESS_STATES).toEqual(RUN_PROGRESS_STATE_VALUES);
    for (const state of RUN_PROGRESS_STATES) {
      expect(runProgressSchema.safeParse(validRunProgress({ state })).success).toBe(true);
    }
  });

  test("canonical plan fixture state parses and is represented by the helper type", () => {
    const fixturePath = path.join(
      process.cwd(),
      "PLAN/oracle-vnext-plan-bundle-v18.0.0/fixtures/run-progress.json",
    );
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

    expect(fixture.state).toBe("waiting_for_live_provider_approval");
    expect(RUN_PROGRESS_STATES).toContain(fixture.state);
    expect(runProgressSchema.safeParse(fixture).success).toBe(true);
  });

  test("builder still clamps caller-supplied progress before schema validation", () => {
    const event = buildRunProgressEvent({
      run_id: "run-clamped",
      profile: "balanced",
      state: "running",
      current_stage: "first_plan",
      progress_percent: 500,
      user_visible_message: "Running.",
    });

    expect(event.progress_percent).toBe(99);
    expect(runProgressSchema.safeParse(event).success).toBe(true);
  });

  test("waiting_for_live_provider_approval has a stable blocker default", () => {
    const event = buildRunProgressEvent({
      run_id: "run-waiting",
      profile: "balanced",
      state: "waiting_for_live_provider_approval",
      current_stage: "preflight",
      user_visible_message: "Waiting for live provider approval.",
    });

    expect(event.blocked_reason).toBe("live_provider_approval_required");
    expect(runProgressSchema.safeParse(event).success).toBe(true);
  });

  test("elapsed progress helper is bounded for live heartbeat callers", () => {
    expect(progressPercentFromElapsed(0, 10_000)).toBe(0);
    expect(progressPercentFromElapsed(5_000, 10_000)).toBe(50);
    expect(progressPercentFromElapsed(500_000, 10_000)).toBe(99);
    expect(progressPercentFromElapsed(5_000, 0)).toBe(0);
  });
});
