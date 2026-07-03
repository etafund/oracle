import { describe, expect, it } from "vitest";
import { resolveLanePolicy } from "../../src/cli/lanePolicy.js";
import { LaneRouteBlockError } from "../../src/cli/routeBlockError.js";

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
