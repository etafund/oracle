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

  it("resolves --lane chatgpt-pro as an enabled browser review lane", () => {
    const decision = resolveLanePolicy({
      lane: "chatgpt-pro",
      prompt: "Review this plan",
      files: ["src/index.ts"],
    });
    expect(decision.ok).toBe(true);
    expect(decision.ok && decision.resolvedLane).toMatchObject({
      lane: "chatgpt-pro",
      canonicalId: "chatgpt_pro_browser",
      engine: "browser",
      accessPath: "chatgpt_pro_browser_automation",
      inferredFrom: "lane",
      readiness: "enabled",
      normalizedEngineOptions: {
        engine: "browser",
        model: "gpt-5.5-pro",
        browserThinkingTime: "extended",
        browserModelStrategy: "select",
        browserArchive: "auto",
        browserAttachments: "auto",
      },
    });
  });

  it("resolves --lane gemini-deep-think as an enabled browser review lane", () => {
    const decision = resolveLanePolicy({
      lane: "gemini-deep-think",
      prompt: "Review this plan",
      files: ["src/main.ts"],
    });
    expect(decision.ok).toBe(true);
    expect(decision.ok && decision.resolvedLane).toMatchObject({
      lane: "gemini-deep-think",
      canonicalId: "gemini_pro_deep_think_browser",
      engine: "browser",
      accessPath: "gemini_pro_deep_think_browser_automation",
      inferredFrom: "lane",
      readiness: "enabled",
      normalizedEngineOptions: {
        engine: "browser",
        model: "gemini-3.1-pro-deep-think",
        geminiDeepThink: true,
        geminiDeepThinkFallback: "fail",
        browserModelStrategy: "select",
        browserArchive: "auto",
        browserAttachments: "auto",
      },
    });
  });

  it("blocks contradictory lane alias engine/model options before backend startup", () => {
    const wrongEngine = resolveLanePolicy({
      lane: "chatgpt-pro",
      engine: "api",
      prompt: "Review this plan",
    });
    const wrongModel = resolveLanePolicy({
      lane: "gemini-deep-think",
      model: "gpt-5.5-pro",
      prompt: "Review this plan",
    });

    expect(wrongEngine.ok).toBe(false);
    expect(!wrongEngine.ok && wrongEngine.blockedReason).toBe("chatgpt_pro_conflicts_with_engine");
    expect(wrongModel.ok).toBe(false);
    expect(!wrongModel.ok && wrongModel.blockedReason).toBe(
      "gemini_deep_think_conflicts_with_model",
    );
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

  it("keeps strict lane policy for legacy routes unless callers explicitly request pass-through", () => {
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

  it("keeps legacy --engine/--model routes available when callers explicitly request pass-through", () => {
    const chatgptLegacy = resolveLanePolicy({
      model: "gpt-5.5-pro",
      engine: "browser",
      browserFlags: ["browserThinkingTime"],
      allowLegacyRoutes: true,
    });
    const geminiLegacy = resolveLanePolicy({
      model: "gemini-3.1-pro-deep-think",
      engine: "browser",
      browserFlags: ["browserModelStrategy"],
      allowLegacyRoutes: true,
    });
    expect(chatgptLegacy).toEqual({ ok: true, resolvedLane: null });
    expect(geminiLegacy).toEqual({ ok: true, resolvedLane: null });
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
