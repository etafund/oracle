import { isProModel } from "../oracle/modelResolver.js";
import type { ReasoningMode } from "../oracle/types.js";

export type EngineMode = "api" | "browser" | "claude-code";

export function defaultWaitPreference(
  model: string,
  engine: EngineMode,
  reasoningMode?: ReasoningMode,
): boolean {
  // Pro-class API runs can take a long time; prefer non-blocking unless explicitly overridden.
  if (engine === "api" && (isProModel(model) || reasoningMode === "pro")) {
    return false;
  }
  return true; // browser or non-pro models are fast enough to block by default
}

/**
 * Determine which engine to use based on CLI flags and the environment.
 *
 * Precedence:
 * 1) Legacy --browser flag forces browser.
 * 2) Explicit --engine value.
 * 3) Explicit API provider routing flags force API.
 * 4) ORACLE_ENGINE environment override (api|browser|claude-code).
 * 5) Config engine value.
 * 6) API environment decides: api when set, otherwise browser.
 */
export function resolveEngine({
  engine,
  configEngine,
  browserFlag,
  apiProviderRequested,
  env,
}: {
  engine?: EngineMode;
  configEngine?: EngineMode;
  browserFlag?: boolean;
  apiProviderRequested?: boolean;
  env: NodeJS.ProcessEnv;
}): EngineMode {
  if (browserFlag) {
    return "browser";
  }
  if (engine) {
    return engine;
  }
  if (apiProviderRequested) {
    return "api";
  }
  const envEngine = normalizeEngineMode(env.ORACLE_ENGINE);
  if (envEngine) {
    return envEngine;
  }
  // Normalize the config-file engine the same way as ORACLE_ENGINE: a
  // mis-cased or space-padded value ("Browser", "browser ") must not slip
  // through verbatim and misroute the run (downstream compares against exact
  // lowercase literals). An invalid value falls through rather than misrouting.
  const normalizedConfigEngine = normalizeEngineMode(configEngine);
  if (normalizedConfigEngine) {
    return normalizedConfigEngine;
  }
  return hasApiEnvironment(env) ? "api" : "browser";
}

function hasApiEnvironment(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.OPENAI_API_KEY || env.OPENROUTER_API_KEY);
}

function normalizeEngineMode(raw: unknown): EngineMode | null {
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "api") return "api";
  if (normalized === "browser") return "browser";
  if (normalized === "claude-code") return "claude-code";
  return null;
}
