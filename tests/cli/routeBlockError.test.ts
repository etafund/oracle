import { describe, expect, it } from "vitest";
import { resolveLanePolicy } from "../../src/cli/lanePolicy.js";
import { LaneRouteBlockError, describeLaneBlockReason } from "../../src/cli/routeBlockError.js";

describe("LaneRouteBlockError", () => {
  it("carries the route-block contract for JSON envelopes and human stderr", () => {
    const decision = resolveLanePolicy({ engine: "api", model: "fable" });
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      throw new Error("expected route block");
    }

    const error = new LaneRouteBlockError(decision);
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain("Oracle v1 agent runs are gated to enabled reviewed lanes.");
    expect(error.message).toContain("oracle --lane fable-local");
    expect(error.details).toMatchObject({
      stage: "agent_lane_blocked",
      category: "route-block",
      exitCode: 2,
      policyVersion: "agent-lanes.v1",
      blockedReason: "fable_requires_fable_local_lane",
      noBackendStarted: true,
      capabilitiesCommand: "oracle capabilities --json",
    });
    expect(error.details?.enabledLanes).toEqual([
      {
        lane: "chatgpt-pro",
        command: 'oracle --lane chatgpt-pro --prompt "..." --file path',
      },
      {
        lane: "gemini-deep-think",
        command: 'oracle --lane gemini-deep-think --prompt "..." --file path',
      },
      {
        lane: "fable-local",
        command: 'oracle --lane fable-local --prompt "..." --file path',
      },
    ]);
    expect(error.details?.deferredLanes).toEqual([]);
  });
});

describe("error-teaches: lane route blocks name the exact corrected command", () => {
  // Agent-ergonomics Axiom 6 (error-teaches): every route-block message
  // must name (a) what failed, (b) which reason, (c) the exact
  // copy-pasteable corrected command — not just a bare `blockedReason`
  // code. These pin both the human stderr text and the JSON envelope's
  // `fix_command`/`details.fixCommand` field.

  it("unknown_lane suggests the closest valid lane (typo correction)", () => {
    const decision = resolveLanePolicy({ lane: "chatgpt-pr", prompt: "hi" });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("expected route block");
    expect(decision.blockedReason).toBe("unknown_lane");

    const error = new LaneRouteBlockError(decision);
    expect(error.message).toContain('Blocked reason: unknown_lane');
    expect(error.message).toContain('Fix: oracle -p "<prompt>" --lane chatgpt-pro');
    expect(error.details?.fixCommand).toBe('oracle -p "<prompt>" --lane chatgpt-pro   # closest match to --lane chatgpt-pr');
  });

  it("unknown_lane falls back to the generic fix for an unrecognizable value", () => {
    const decision = resolveLanePolicy({ lane: "banana", prompt: "hi" });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("expected route block");

    const guidance = describeLaneBlockReason(decision);
    expect(guidance.fixCommand).toContain('--lane fable-local');
    expect(guidance.fixCommand).toContain('--lane chatgpt-pro');
    expect(guidance.fixCommand).toContain('--lane gemini-deep-think');
  });

  it("missing_reviewed_lane names the exact fix for a bare prompt with no lane", () => {
    const decision = resolveLanePolicy({ prompt: "hi" });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("expected route block");
    expect(decision.blockedReason).toBe("missing_reviewed_lane");

    const error = new LaneRouteBlockError(decision);
    expect(error.message).toContain('Fix: oracle -p "<prompt>" --lane fable-local');
    expect(error.details?.fixCommand).toContain('--lane fable-local');
  });

  it("fable_local_conflicts_with_model names the drop-the-flag fix", () => {
    const decision = resolveLanePolicy({ lane: "fable-local", model: "gpt-5.5-pro", prompt: "hi" });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("expected route block");
    expect(decision.blockedReason).toBe("fable_local_conflicts_with_model");

    const error = new LaneRouteBlockError(decision);
    expect(error.message).toContain("conflicts with --model gpt-5.5-pro");
    expect(error.message).toContain('Fix: oracle -p "<prompt>" --lane fable-local   # drop --model');
  });

  it("gemini_deep_think_conflicts_with_model names the drop-the-flag fix", () => {
    const decision = resolveLanePolicy({
      lane: "gemini-deep-think",
      model: "gemini-1.5-pro",
      prompt: "hi",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("expected route block");
    expect(decision.blockedReason).toBe("gemini_deep_think_conflicts_with_model");

    const guidance = describeLaneBlockReason(decision);
    expect(guidance.fixCommand).toBe(
      'oracle -p "<prompt>" --lane gemini-deep-think   # drop --model',
    );
  });
});
