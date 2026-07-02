import { describe, expect, it } from "vitest";
import { listLaneTemplates, resolveLanePolicy } from "../../src/cli/lanePolicy.js";

describe("lane policy", () => {
  it("declares the three reviewed lane templates", () => {
    expect(listLaneTemplates().map((entry) => entry.lane)).toEqual([
      "chatgpt-pro",
      "gemini-deep-think",
      "fable-local",
    ]);
  });

  it("resolves --lane fable-local to local Claude Code", () => {
    const decision = resolveLanePolicy({
      lane: "fable-local",
      prompt: "Review this plan",
      files: ["docs/plan.md"],
    });
    expect(decision.ok).toBe(true);
    expect(decision.ok && decision.resolvedLane).toMatchObject({
      policyVersion: "agent-lanes.v1",
      lane: "fable-local",
      canonicalId: "claude_code_fable_local",
      engine: "claude-code",
      accessPath: "claude_code_subscription_cli",
      inferredFrom: "lane",
      readiness: "hidden-alpha-only",
    });
  });

  it("resolves exact expert engine/model compatibility form", () => {
    const decision = resolveLanePolicy({
      engine: "claude-code",
      model: "claude-fable-5",
      prompt: "Review this plan",
    });
    expect(decision.ok).toBe(true);
    expect(decision.ok && decision.resolvedLane?.lane).toBe("fable-local");
    expect(decision.ok && decision.resolvedLane?.inferredFrom).toBe("legacy-engine-model");
  });

  it("blocks deferred browser lane templates in hidden alpha", () => {
    const decision = resolveLanePolicy({ lane: "chatgpt-pro", prompt: "Review this plan" });
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.blockedReason).toBe("selector_state_unknown");
    expect(!decision.ok && decision.deferredLanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lane: "chatgpt-pro", status: "not-ready" }),
        expect.objectContaining({ lane: "gemini-deep-think", status: "deferred" }),
      ]),
    );
  });

  it("blocks API fable instead of allowing API/OpenRouter/browser reinterpretation", () => {
    const decision = resolveLanePolicy({ engine: "api", model: "fable" });
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.blockedReason).toBe("fable_requires_fable_local_lane");
    expect(!decision.ok && decision.noBackendStarted).toBe(true);
  });

  it("blocks bare prompt/default routes instead of choosing a default lane", () => {
    const decision = resolveLanePolicy({ prompt: "Review this plan" });
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.blockedReason).toBe("missing_reviewed_lane");
  });

  it("blocks exact ChatGPT Pro legacy routes while the browser lane is not ready", () => {
    const modelOnly = resolveLanePolicy({ model: "gpt-5.5-pro" });
    const browserExact = resolveLanePolicy({
      engine: "browser",
      model: "gpt-5.5-pro",
      browserFlags: ["browserThinkingTime"],
    });
    expect(modelOnly.ok).toBe(false);
    expect(!modelOnly.ok && modelOnly.blockedReason).toBe("selector_state_unknown");
    expect(browserExact.ok).toBe(false);
    expect(!browserExact.ok && browserExact.blockedReason).toBe("selector_state_unknown");
  });

  it("blocks unsupported API/browser/model routes", () => {
    const apiClaude = resolveLanePolicy({ engine: "api", model: "claude-4.6-sonnet" });
    const vagueBrowser = resolveLanePolicy({ engine: "browser" });
    const unknownModel = resolveLanePolicy({ model: "some-new-model" });
    expect(apiClaude.ok).toBe(false);
    expect(!apiClaude.ok && apiClaude.blockedReason).toBe("unsupported_api_route");
    expect(vagueBrowser.ok).toBe(false);
    expect(!vagueBrowser.ok && vagueBrowser.blockedReason).toBe("unsupported_browser_route");
    expect(unknownModel.ok).toBe(false);
    expect(!unknownModel.ok && unknownModel.blockedReason).toBe("unsupported_model_route");
  });

  it("blocks fable multi-model fan-out", () => {
    const decision = resolveLanePolicy({ models: ["gpt-5.5-pro", "fable"] });
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.blockedReason).toBe("fable_multi_model_fanout_blocked");
  });

  it("blocks all multi-model fan-out under strict active lane policy", () => {
    const decision = resolveLanePolicy({ models: ["gpt-5.5-pro", "gemini-3-pro"] });
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.blockedReason).toBe("multi_model_fanout_blocked");
  });

  it("blocks env/config claude-code defaults without explicit per-run intent", () => {
    const envDecision = resolveLanePolicy({
      model: "gpt-5.1",
      envEngine: "claude-code",
    });
    const configDecision = resolveLanePolicy({
      model: "gpt-5.1",
      configEngine: "claude-code",
    });
    expect(envDecision.ok).toBe(false);
    expect(!envDecision.ok && envDecision.blockedReason).toBe(
      "oracle_engine_claude_code_requires_explicit_lane",
    );
    expect(configDecision.ok).toBe(false);
    expect(!configDecision.ok && configDecision.blockedReason).toBe(
      "config_engine_claude_code_requires_explicit_lane",
    );
  });

  it("blocks browser and remote flags for fable-local", () => {
    const decision = resolveLanePolicy({
      lane: "fable-local",
      remoteHost: "127.0.0.1:9470",
      browserFlags: ["browserModelStrategy"],
    });
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.blockedReason).toBe("fable_local_requires_local_cli");
  });

  it("allows legacy pass-through only when callers explicitly request it", () => {
    const decision = resolveLanePolicy({
      model: "gpt-5.1",
      allowLegacyRoutes: true,
    });
    expect(decision).toEqual({ ok: true, resolvedLane: null });
  });
});
