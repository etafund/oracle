import type { EngineMode } from "./engine.js";

export const AGENT_LANE_POLICY_VERSION = "agent-lanes.v1" as const;

export type OracleLane = "chatgpt-pro" | "gemini-deep-think" | "fable-local";

export type LaneCanonicalId =
  | "chatgpt_pro_browser"
  | "gemini_pro_deep_think_browser"
  | "claude_code_fable_local";

export type LaneAccessPath =
  | "chatgpt_pro_browser_automation"
  | "gemini_pro_deep_think_browser_automation"
  | "claude_code_subscription_cli";

export type LaneReadiness = "enabled" | "hidden-alpha-only" | "deferred" | "not-ready";

export interface LaneTemplate {
  lane: OracleLane;
  canonicalId: LaneCanonicalId;
  engine: Exclude<EngineMode, "api">;
  accessPath: LaneAccessPath;
  readiness: LaneReadiness;
  enabledForCli: boolean;
  command: string;
  doctorCommand: string;
  transportEligibility: "local-only" | "browser-automation-local-or-approved-remote";
  blockedReason?: string;
  normalizedEngineOptions: Record<string, unknown>;
  refusedPatterns: string[];
  runtimeAssertions: string[];
  /**
   * The flag(s) that distinguish this lane from a bare `--lane <id>` run —
   * i.e. what an agent needs to add on top of `--lane` to hit this exact
   * reviewed route. Consumed by `oracle capabilities --json` and
   * `oracle robot-docs` so the self-doc surfaces never hand-copy lane
   * flags out of sync with this registry (the single source of truth for
   * lane behavior).
   */
  keyFlags: readonly string[];
}

export const LANE_TEMPLATES: readonly LaneTemplate[] = [
  {
    lane: "chatgpt-pro",
    canonicalId: "chatgpt_pro_browser",
    engine: "browser",
    accessPath: "chatgpt_pro_browser_automation",
    readiness: "enabled",
    enabledForCli: true,
    command: 'oracle --lane chatgpt-pro --prompt "..." --file path',
    doctorCommand:
      "oracle doctor chatgpt --pro --extended-reasoning --remote-browser preferred --json",
    transportEligibility: "browser-automation-local-or-approved-remote",
    normalizedEngineOptions: {
      engine: "browser",
      model: "gpt-5.5-pro",
      browserThinkingTime: "extended",
      browserModelStrategy: "select",
      browserArchive: "auto",
      browserAttachments: "auto",
    },
    refusedPatterns: ["--engine api", "--models", "--engine claude-code", "gemini-*", "fable"],
    runtimeAssertions: [
      "chatgpt_signed_in",
      "chatgpt_pro_selector_state_verified",
      "extended_thinking_selected_before_submit",
    ],
    keyFlags: ["--lane chatgpt-pro", "--browser-thinking-time extended"],
  },
  {
    lane: "gemini-deep-think",
    canonicalId: "gemini_pro_deep_think_browser",
    engine: "browser",
    accessPath: "gemini_pro_deep_think_browser_automation",
    readiness: "enabled",
    enabledForCli: true,
    command: 'oracle --lane gemini-deep-think --prompt "..." --file path',
    doctorCommand: "oracle doctor gemini --deep-think --remote-browser preferred --json",
    transportEligibility: "browser-automation-local-or-approved-remote",
    normalizedEngineOptions: {
      engine: "browser",
      model: "gemini-3.1-pro-deep-think",
      geminiDeepThink: true,
      geminiDeepThinkFallback: "fail",
      browserModelStrategy: "select",
      browserArchive: "auto",
      browserAttachments: "auto",
    },
    refusedPatterns: ["--engine api", "--models", "--engine claude-code", "chatgpt-*", "fable"],
    runtimeAssertions: [
      "gemini_signed_in",
      "gemini_deep_think_selector_state_verified",
      "deep_think_selected_before_submit",
    ],
    keyFlags: ["--lane gemini-deep-think", "--gemini-deep-think"],
  },
  {
    lane: "fable-local",
    canonicalId: "claude_code_fable_local",
    engine: "claude-code",
    accessPath: "claude_code_subscription_cli",
    readiness: "hidden-alpha-only",
    enabledForCli: true,
    command: 'oracle --lane fable-local --prompt "..." --file path',
    doctorCommand: "oracle doctor lanes --json",
    transportEligibility: "local-only",
    normalizedEngineOptions: {
      engine: "claude-code",
      model: "fable",
      effort: "xhigh",
      readOnly: true,
    },
    refusedPatterns: [
      "--engine api",
      "--models",
      "--browser-*",
      "--remote-host",
      "chatgpt-*",
      "gemini-*",
    ],
    runtimeAssertions: [
      "local_claude_code_cli",
      "anthropic_api_key_absent",
      "no_tools",
      "no_mcp_servers",
      "fable_model_verified_when_visible",
    ],
    keyFlags: ["--lane fable-local"],
  },
] as const;

export function getLaneTemplate(lane: string | undefined): LaneTemplate | null {
  if (!lane) return null;
  return LANE_TEMPLATES.find((entry) => entry.lane === lane) ?? null;
}

export function enabledLaneCommands(): Array<{ lane: OracleLane; command: string }> {
  return LANE_TEMPLATES.filter((entry) => entry.enabledForCli).map(({ lane, command }) => ({
    lane,
    command,
  }));
}

export function deferredLaneStatuses(): Array<{
  lane: OracleLane;
  status: "deferred" | "not-ready";
  reason: string;
}> {
  return LANE_TEMPLATES.filter((entry) => !entry.enabledForCli).map((entry) => ({
    lane: entry.lane,
    status: entry.readiness === "deferred" ? "deferred" : "not-ready",
    reason: entry.blockedReason ?? entry.readiness,
  }));
}
