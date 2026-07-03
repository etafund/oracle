import type { EngineMode } from "./engine.js";
import { isChatGptProModelAlias, isGeminiDeepThinkModelAlias } from "./options.js";
import {
  AGENT_LANE_POLICY_VERSION,
  LANE_TEMPLATES,
  deferredLaneStatuses,
  enabledLaneCommands,
  getLaneTemplate,
  type LaneAccessPath,
  type LaneCanonicalId,
  type LaneReadiness,
  type OracleLane,
} from "./laneRegistry.js";

export type LaneInferenceSource = "lane" | "legacy-engine-model" | "mcp-lane" | "mcp-engine-model";

export interface ResolvedOracleLane {
  policyVersion: typeof AGENT_LANE_POLICY_VERSION;
  lane: OracleLane;
  canonicalId: LaneCanonicalId;
  engine: Exclude<EngineMode, "api">;
  accessPath: LaneAccessPath;
  inferredFrom: LaneInferenceSource;
  transportEligibility: "local-only" | "browser-automation-local-or-approved-remote";
  readiness: LaneReadiness;
  runtimeAssertions: readonly string[];
  replacementCommand: string;
  normalizedEngineOptions: Record<string, unknown>;
  preservedRequestOptions: Record<string, unknown>;
}

export interface LanePolicyRequest {
  lane?: string;
  engine?: EngineMode | string;
  model?: string;
  models?: readonly string[];
  prompt?: string;
  files?: readonly string[];
  slug?: string;
  source?: "cli" | "mcp" | "runOptions";
  envEngine?: string;
  configEngine?: string;
  remoteHost?: string;
  remoteChrome?: string;
  remoteBrowser?: string;
  browserFlags?: readonly string[];
  apiProviderRequested?: boolean;
  allowLegacyRoutes?: boolean;
}

export interface LanePolicyPass {
  ok: true;
  resolvedLane: ResolvedOracleLane | null;
}

export interface LaneRouteBlock {
  ok: false;
  policyVersion: typeof AGENT_LANE_POLICY_VERSION;
  code: "agent_lane_blocked";
  category: "route-block";
  exitCode: 2;
  attemptedRoute: Record<string, unknown>;
  blockedReason: string;
  normalizedOptions: Record<string, unknown>;
  sourcePrecedence: string[];
  enabledLanes: Array<{ lane: OracleLane; command: string }>;
  deferredLanes: Array<{ lane: OracleLane; status: "deferred" | "not-ready"; reason: string }>;
  noBackendStarted: true;
  capabilitiesCommand: "oracle capabilities --json";
}

export type LanePolicyDecision = LanePolicyPass | LaneRouteBlock;

export function resolveLanePolicy(request: LanePolicyRequest): LanePolicyDecision {
  const normalized = normalizeRequest(request);
  if (normalized.models.some(isFableModel)) {
    return routeBlock(normalized, "fable_multi_model_fanout_blocked");
  }
  if (!normalized.allowLegacyRoutes && normalized.models.length > 0) {
    return routeBlock(normalized, "multi_model_fanout_blocked");
  }

  if (normalized.lane) {
    const template = getLaneTemplate(normalized.lane);
    if (!template) {
      return routeBlock(normalized, "unknown_lane");
    }
    if (!template.enabledForCli) {
      return routeBlock(normalized, template.blockedReason ?? "lane_not_ready");
    }
    if (template.lane === "fable-local") {
      const conflict = fableConflictReason(normalized);
      if (conflict) {
        return routeBlock(normalized, conflict);
      }
      return {
        ok: true,
        resolvedLane: resolvedFromTemplate(template, "lane", normalized),
      };
    }
    const conflict = browserLaneConflictReason(template.lane, normalized);
    if (conflict) {
      return routeBlock(normalized, conflict);
    }
    return {
      ok: true,
      resolvedLane: resolvedFromTemplate(template, "lane", normalized),
    };
  }

  if (normalized.engine === "claude-code") {
    if (normalized.model && isFableModel(normalized.model)) {
      const conflict = fableConflictReason(normalized, { allowEngine: true });
      if (conflict) {
        return routeBlock(normalized, conflict);
      }
      const template = getLaneTemplate("fable-local");
      if (!template) {
        return routeBlock(normalized, "fable_local_lane_missing");
      }
      return {
        ok: true,
        resolvedLane: resolvedFromTemplate(template, "legacy-engine-model", normalized),
      };
    }
    return routeBlock(normalized, "claude_code_requires_fable_local_lane");
  }

  if (normalized.envEngine === "claude-code") {
    return routeBlock(normalized, "oracle_engine_claude_code_requires_explicit_lane");
  }
  if (normalized.configEngine === "claude-code") {
    return routeBlock(normalized, "config_engine_claude_code_requires_explicit_lane");
  }
  if (normalized.model && isFableModel(normalized.model)) {
    return routeBlock(normalized, "fable_requires_fable_local_lane");
  }
  if (normalized.allowLegacyRoutes) {
    return { ok: true, resolvedLane: null };
  }
  const legacyBlockReason = reviewedLegacyBlockReason(normalized);
  if (legacyBlockReason) {
    return routeBlock(normalized, legacyBlockReason);
  }

  return routeBlock(normalized, "missing_reviewed_lane");
}

export function isFableModel(model: string | undefined): boolean {
  const normalized = normalizeOptional(model);
  return normalized === "fable" || normalized === "claude-fable-5";
}

interface NormalizedLaneRequest {
  lane?: string;
  engine?: string;
  model?: string;
  models: string[];
  promptPresent: boolean;
  files: string[];
  slug?: string;
  source: "cli" | "mcp" | "runOptions";
  envEngine?: string;
  configEngine?: string;
  remoteHost?: string;
  remoteChrome?: string;
  remoteBrowser?: string;
  browserFlags: string[];
  apiProviderRequested: boolean;
  allowLegacyRoutes: boolean;
}

function normalizeRequest(request: LanePolicyRequest): NormalizedLaneRequest {
  return {
    lane: normalizeOptional(request.lane),
    engine: normalizeOptional(request.engine),
    model: normalizeOptional(request.model),
    models: Array.isArray(request.models)
      ? request.models.map(normalizeOptional).filter((entry): entry is string => Boolean(entry))
      : [],
    promptPresent: typeof request.prompt === "string" && request.prompt.trim().length > 0,
    files: Array.isArray(request.files) ? request.files.filter(Boolean).map(String) : [],
    slug: typeof request.slug === "string" && request.slug.trim() ? request.slug.trim() : undefined,
    source: request.source ?? "cli",
    envEngine: normalizeOptional(request.envEngine),
    configEngine: normalizeOptional(request.configEngine),
    remoteHost: normalizeOptional(request.remoteHost),
    remoteChrome: normalizeOptional(request.remoteChrome),
    remoteBrowser: normalizeOptional(request.remoteBrowser),
    browserFlags: Array.isArray(request.browserFlags)
      ? request.browserFlags.filter((entry) => entry.trim().length > 0)
      : [],
    apiProviderRequested: Boolean(request.apiProviderRequested),
    allowLegacyRoutes: Boolean(request.allowLegacyRoutes),
  };
}

function normalizeOptional(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
}

function fableConflictReason(
  request: NormalizedLaneRequest,
  { allowEngine = false }: { allowEngine?: boolean } = {},
): string | null {
  if (!allowEngine && request.engine && request.engine !== "claude-code") {
    return "fable_local_conflicts_with_engine";
  }
  if (request.model && !isFableModel(request.model)) {
    return "fable_local_conflicts_with_model";
  }
  if (request.models.length > 0) {
    return "fable_multi_model_fanout_blocked";
  }
  if (request.remoteHost || request.remoteChrome || request.remoteBrowser) {
    return "fable_local_requires_local_cli";
  }
  if (request.browserFlags.length > 0) {
    return "fable_local_conflicts_with_browser_flags";
  }
  if (request.apiProviderRequested) {
    return "fable_local_conflicts_with_api_provider";
  }
  return null;
}

function browserLaneConflictReason(
  lane: OracleLane,
  request: NormalizedLaneRequest,
): string | null {
  if (request.engine && request.engine !== "browser") {
    return `${laneReasonPrefix(lane)}_conflicts_with_engine`;
  }
  if (request.models.length > 0) {
    return "multi_model_fanout_blocked";
  }
  if (!request.model) {
    return null;
  }
  if (lane === "chatgpt-pro" && !isChatGptProModelAlias(request.model)) {
    return "chatgpt_pro_conflicts_with_model";
  }
  if (lane === "gemini-deep-think" && !isGeminiDeepThinkModelAlias(request.model)) {
    return "gemini_deep_think_conflicts_with_model";
  }
  return null;
}

function laneReasonPrefix(lane: OracleLane): string {
  return lane.replace(/-/gu, "_");
}

function reviewedLegacyBlockReason(request: NormalizedLaneRequest): string | null {
  if (request.model === "gpt-5.5-pro") {
    return "selector_state_unknown";
  }
  if (request.engine === "browser") {
    return "unsupported_browser_route";
  }
  if (request.engine === "api" || request.apiProviderRequested) {
    return "unsupported_api_route";
  }
  if (request.model?.startsWith("gemini")) {
    return "no_active_gemini_lane_or_subscription";
  }
  if (request.model?.startsWith("claude")) {
    return "unsupported_api_route";
  }
  if (request.model) {
    return "unsupported_model_route";
  }
  return null;
}

function resolvedFromTemplate(
  template: NonNullable<ReturnType<typeof getLaneTemplate>>,
  inferredFrom: LaneInferenceSource,
  request: NormalizedLaneRequest,
): ResolvedOracleLane {
  return {
    policyVersion: AGENT_LANE_POLICY_VERSION,
    lane: template.lane,
    canonicalId: template.canonicalId,
    engine: template.engine,
    accessPath: template.accessPath,
    inferredFrom,
    transportEligibility: template.transportEligibility,
    readiness: template.readiness,
    runtimeAssertions: template.runtimeAssertions,
    replacementCommand: template.command,
    normalizedEngineOptions: {
      ...template.normalizedEngineOptions,
      ...(request.model && isFableModel(request.model) ? { model: request.model } : {}),
    },
    preservedRequestOptions: {
      prompt: request.promptPresent ? "caller supplied" : undefined,
      files: request.files.length > 0 ? request.files : undefined,
      slug: request.slug,
    },
  };
}

function routeBlock(request: NormalizedLaneRequest, blockedReason: string): LaneRouteBlock {
  return {
    ok: false,
    policyVersion: AGENT_LANE_POLICY_VERSION,
    code: "agent_lane_blocked",
    category: "route-block",
    exitCode: 2,
    attemptedRoute: attemptedRoute(request),
    blockedReason,
    normalizedOptions: attemptedRoute(request),
    sourcePrecedence: ["cli", "env", "config", "defaults"],
    enabledLanes: enabledLaneCommands(),
    deferredLanes: deferredLaneStatuses(),
    noBackendStarted: true,
    capabilitiesCommand: "oracle capabilities --json",
  };
}

function attemptedRoute(request: NormalizedLaneRequest): Record<string, unknown> {
  return {
    lane: request.lane ?? null,
    engine: request.engine ?? null,
    model: request.model ?? null,
    models: request.models.length > 0 ? request.models : undefined,
    envEngine: request.envEngine ?? undefined,
    configEngine: request.configEngine ?? undefined,
    remoteHost: request.remoteHost ?? undefined,
    remoteChrome: request.remoteChrome ?? undefined,
    remoteBrowser: request.remoteBrowser ?? undefined,
    browserFlags: request.browserFlags.length > 0 ? request.browserFlags : undefined,
    apiProviderRequested: request.apiProviderRequested || undefined,
    source: request.source,
  };
}

export function listLaneTemplates(): typeof LANE_TEMPLATES {
  return LANE_TEMPLATES;
}
