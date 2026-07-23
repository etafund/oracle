import type { ClaudeCodeNormalizedEvent } from "./streamParser.js";

export type ClaudeCodeModelVerificationStatus =
  | "requested_only"
  | "observed"
  | "fallback_observed"
  | "unknown";

export type VisibleThinkingCaptured = boolean | "unknown";

export interface ClaudeCodeVerificationFailure {
  code: string;
  field: string;
  message: string;
}

export interface ClaudeCodeVerificationMetadata {
  modelRequested: string;
  sessionIdObserved: string | null;
  modelResolvedFromInit: string | null;
  modelObserved: string | null;
  modelUsageKeys: string[];
  modelUsageAuxiliaryKeys: string[];
  modelVerificationStatus: ClaudeCodeModelVerificationStatus;
  totalCostUsdObserved: number | null;
  visibleThinkingCaptured: VisibleThinkingCaptured;
  apiKeySource: string | null;
}

export interface ClaudeCodeVerificationResult {
  ok: boolean;
  failures: ClaudeCodeVerificationFailure[];
  metadata: ClaudeCodeVerificationMetadata;
}

export interface VerifyClaudeCodeRunOptions {
  requestedModel?: string;
  /** Exact builder-owned UUID expected in Claude's system/init event. */
  expectedSessionId?: string;
  /** Persistence is allowed only for reviewed resumable Fable sessions. */
  allowSessionPersistence?: boolean;
  allowedSubscriptionApiKeySources?: string[];
  allowedBuiltinAgents?: string[];
}

const DEFAULT_SUBSCRIPTION_API_KEY_SOURCES = ["none"] as const;
const DEFAULT_ALLOWED_BUILTIN_AGENTS = ["claude", "Explore", "general-purpose", "Plan"] as const;
const AUXILIARY_MODEL_ALLOWLIST = ["claude-haiku-4-5-20251001"] as const;

export function verifyClaudeCodeRun(
  events: readonly (ClaudeCodeNormalizedEvent | unknown)[],
  options: VerifyClaudeCodeRunOptions = {},
): ClaudeCodeVerificationResult {
  const requestedModel = options.requestedModel ?? "fable";
  const allowedAuth = new Set(
    (options.allowedSubscriptionApiKeySources ?? [...DEFAULT_SUBSCRIPTION_API_KEY_SOURCES]).map(
      (v) => v.toLowerCase(),
    ),
  );
  const allowedAgents = new Set(
    options.allowedBuiltinAgents ?? [...DEFAULT_ALLOWED_BUILTIN_AGENTS],
  );
  const jsonEvents = events.map((event) => eventJson(event)).filter((event) => event !== null);
  const startup = jsonEvents.find(isStartupEvent);
  const resultEvents = jsonEvents.filter(isResultEvent);
  const result = resultEvents.at(-1) ?? null;
  const failures: ClaudeCodeVerificationFailure[] = [];

  const metadata: ClaudeCodeVerificationMetadata = {
    modelRequested: requestedModel,
    sessionIdObserved: startup ? stringField(startup, "session_id") : null,
    modelResolvedFromInit: startup ? stringField(startup, "model") : null,
    modelObserved: null,
    modelUsageKeys: [],
    modelUsageAuxiliaryKeys: [],
    modelVerificationStatus: "unknown",
    totalCostUsdObserved: result ? numberField(result, "total_cost_usd") : null,
    visibleThinkingCaptured: detectVisibleThinking(jsonEvents),
    apiKeySource: startup ? stringField(startup, "apiKeySource") : null,
  };

  if (!startup) {
    failure(
      failures,
      "missing_startup",
      "type",
      "No Claude Code system/init startup event was observed.",
    );
    return { ok: false, failures, metadata };
  }

  const apiKeySource = stringField(startup, "apiKeySource");
  if (!apiKeySource) {
    failure(
      failures,
      "missing_api_key_source",
      "apiKeySource",
      "Startup event omitted apiKeySource.",
    );
  } else if (!allowedAuth.has(apiKeySource.toLowerCase())) {
    failure(
      failures,
      "api_auth_source_rejected",
      "apiKeySource",
      `Startup apiKeySource ${apiKeySource} is not the reviewed subscription auth source.`,
    );
  }

  if (options.expectedSessionId) {
    const observedSessionId = stringField(startup, "session_id");
    if (!observedSessionId) {
      failure(
        failures,
        "missing_session_id",
        "session_id",
        "Startup event omitted the builder-owned Claude session id.",
      );
    } else if (observedSessionId !== options.expectedSessionId) {
      failure(
        failures,
        "session_id_mismatch",
        "session_id",
        `Startup session id ${observedSessionId} did not match the builder-owned session id.`,
      );
    }
  }

  const initModel = stringField(startup, "model");
  if (!initModel) {
    failure(failures, "missing_model", "model", "Startup event omitted model.");
  } else if (!isFableCompatibleModel(initModel)) {
    failure(
      failures,
      "model_mismatch",
      "model",
      `Startup model ${initModel} is not compatible with requested Fable local mode.`,
    );
  } else {
    metadata.modelObserved = initModel;
    metadata.modelVerificationStatus = "observed";
  }

  requireEmptyArray(startup, "tools", failures);
  requireEmptyCollection(startup, "mcp_servers", failures);
  requireExactString(startup, "permissionMode", "plan", failures);
  requireEmptyArray(startup, "slash_commands", failures);
  requireEmptyArray(startup, "skills", failures);
  // Claude Code may report installed plugins as inert inventory even when
  // the empty executable surfaces below prove none were activated for this
  // run. Keep validating the field shape without treating inventory alone
  // as tool/MCP/skill/slash-command access.
  requireArray(startup, "plugins", failures);
  requireExactString(startup, "fast_mode_state", "off", failures);
  rejectNonEmptyOptionalCollection(startup, "hooks", failures);
  rejectNonEmptyOptionalCollection(startup, "chrome", failures);
  rejectNonEmptyOptionalCollection(startup, "chrome_integration", failures);
  rejectPresentTruthy(startup, "fallback_model", failures);
  rejectPresentTruthy(startup, "fallbackModel", failures);
  if (!options.allowSessionPersistence) {
    rejectPresentTruthy(startup, "session_persistence", failures);
    rejectPresentTruthy(startup, "sessionPersistence", failures);
  }

  const agents = arrayField(startup, "agents");
  if (agents) {
    const unexpected = agents.filter(
      (agent) => typeof agent !== "string" || !allowedAgents.has(agent),
    );
    if (unexpected.length > 0) {
      failure(
        failures,
        "custom_agents_rejected",
        "agents",
        "Startup event listed custom or unknown Claude Code agents.",
      );
    }
  }

  const modelUsage = result ? objectField(result, "modelUsage") : null;
  if (modelUsage) {
    const keys = Object.keys(modelUsage);
    metadata.modelUsageKeys = keys;
    const fableKeys = keys.filter(isFableCompatibleModel);
    const nonFableKeys = keys.filter((key) => !isFableCompatibleModel(key));
    metadata.modelUsageAuxiliaryKeys = nonFableKeys.filter((key) =>
      AUXILIARY_MODEL_ALLOWLIST.includes(key as (typeof AUXILIARY_MODEL_ALLOWLIST)[number]),
    );
    const allNonFableKeysAreAuxiliary =
      nonFableKeys.length === metadata.modelUsageAuxiliaryKeys.length;

    if (keys.length > 0 && fableKeys.length === 0) {
      metadata.modelObserved = keys[0] ?? metadata.modelObserved;
      metadata.modelVerificationStatus = "fallback_observed";
      failure(
        failures,
        "model_usage_mismatch",
        "modelUsage",
        "Result modelUsage did not include Fable.",
      );
    } else if (!allNonFableKeysAreAuxiliary) {
      failure(
        failures,
        "model_usage_unclassified_auxiliary",
        "modelUsage",
        "Result modelUsage included non-Fable keys that are not classified as auxiliary bookkeeping.",
      );
    } else if (fableKeys[0]) {
      metadata.modelObserved = metadata.modelObserved ?? fableKeys[0];
      metadata.modelVerificationStatus = "observed";
    }
  }

  return { ok: failures.length === 0, failures, metadata };
}

export function isFableCompatibleModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === "fable" || normalized === "claude-fable-5";
}

function eventJson(event: ClaudeCodeNormalizedEvent | unknown): Record<string, unknown> | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const maybeNormalized = event as { json?: unknown };
  const source =
    maybeNormalized.json && typeof maybeNormalized.json === "object" ? maybeNormalized.json : event;
  return source && typeof source === "object" ? (source as Record<string, unknown>) : null;
}

function isStartupEvent(event: Record<string, unknown>): boolean {
  return event.type === "system" && event.subtype === "init";
}

function isResultEvent(event: Record<string, unknown>): boolean {
  return event.type === "result";
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function numberField(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayField(obj: Record<string, unknown>, key: string): unknown[] | null {
  const value = obj[key];
  return Array.isArray(value) ? value : null;
}

function objectField(obj: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = obj[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireEmptyArray(
  obj: Record<string, unknown>,
  field: string,
  failures: ClaudeCodeVerificationFailure[],
): void {
  const value = obj[field];
  if (!Array.isArray(value)) {
    failure(failures, "missing_or_invalid_empty_array", field, `${field} must be an empty array.`);
    return;
  }
  if (value.length > 0) {
    failure(failures, "non_empty_surface", field, `${field} must be empty for read-only v1.`);
  }
}

function requireArray(
  obj: Record<string, unknown>,
  field: string,
  failures: ClaudeCodeVerificationFailure[],
): void {
  if (!Array.isArray(obj[field])) {
    failure(failures, "missing_or_invalid_array", field, `${field} must be an array.`);
  }
}

function requireEmptyCollection(
  obj: Record<string, unknown>,
  field: string,
  failures: ClaudeCodeVerificationFailure[],
): void {
  const value = obj[field];
  if (Array.isArray(value)) {
    if (value.length > 0) {
      failure(failures, "non_empty_surface", field, `${field} must be empty for read-only v1.`);
    }
    return;
  }
  if (value && typeof value === "object") {
    if (Object.keys(value).length > 0) {
      failure(failures, "non_empty_surface", field, `${field} must be empty for read-only v1.`);
    }
    return;
  }
  failure(failures, "missing_or_invalid_empty_collection", field, `${field} must be empty.`);
}

function requireExactString(
  obj: Record<string, unknown>,
  field: string,
  expected: string,
  failures: ClaudeCodeVerificationFailure[],
): void {
  const value = obj[field];
  if (value !== expected) {
    failure(failures, "unexpected_startup_value", field, `${field} must be ${expected}.`);
  }
}

function rejectNonEmptyOptionalCollection(
  obj: Record<string, unknown>,
  field: string,
  failures: ClaudeCodeVerificationFailure[],
): void {
  if (!(field in obj)) {
    return;
  }
  const value = obj[field];
  if (Array.isArray(value) && value.length > 0) {
    failure(failures, "non_empty_surface", field, `${field} must be inactive.`);
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  ) {
    failure(failures, "non_empty_surface", field, `${field} must be inactive.`);
  }
  if (typeof value === "string" && value.trim()) {
    failure(failures, "non_empty_surface", field, `${field} must be inactive.`);
  }
  if (typeof value === "boolean" && value) {
    failure(failures, "non_empty_surface", field, `${field} must be inactive.`);
  }
}

function rejectPresentTruthy(
  obj: Record<string, unknown>,
  field: string,
  failures: ClaudeCodeVerificationFailure[],
): void {
  if (!(field in obj)) {
    return;
  }
  const value = obj[field];
  if (value !== false && value !== null && value !== undefined && value !== "" && value !== "off") {
    failure(failures, "unexpected_startup_value", field, `${field} must be inactive.`);
  }
}

function detectVisibleThinking(
  events: readonly Record<string, unknown>[],
): VisibleThinkingCaptured {
  for (const event of events) {
    if (
      event.type === "thinking" ||
      event.type === "thinking_delta" ||
      event.type === "thinking_summary"
    ) {
      return true;
    }
    const nested = event.event;
    if (nested && typeof nested === "object") {
      const nestedType = (nested as { type?: unknown }).type;
      const delta = (nested as { delta?: unknown }).delta;
      const deltaType =
        delta && typeof delta === "object" ? (delta as { type?: unknown }).type : null;
      if (
        nestedType === "thinking" ||
        nestedType === "thinking_delta" ||
        nestedType === "thinking_summary" ||
        deltaType === "thinking_delta" ||
        deltaType === "thinking"
      ) {
        return true;
      }
    }
  }
  return false;
}

function failure(
  failures: ClaudeCodeVerificationFailure[],
  code: string,
  field: string,
  message: string,
): void {
  failures.push({ code, field, message });
}
