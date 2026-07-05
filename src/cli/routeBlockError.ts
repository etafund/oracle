import { PromptValidationError } from "../oracle/errors.js";
import type { LaneRouteBlock } from "./lanePolicy.js";

export class LaneRouteBlockError extends PromptValidationError {
  readonly exitCode = 2;
  readonly routeBlock: LaneRouteBlock;

  constructor(routeBlock: LaneRouteBlock) {
    const guidance = describeLaneBlockReason(routeBlock);
    super(formatLaneRouteBlockHuman(routeBlock, guidance), {
      stage: routeBlock.code,
      category: routeBlock.category,
      exitCode: routeBlock.exitCode,
      policyVersion: routeBlock.policyVersion,
      attemptedRoute: routeBlock.attemptedRoute,
      blockedReason: routeBlock.blockedReason,
      normalizedOptions: routeBlock.normalizedOptions,
      sourcePrecedence: routeBlock.sourcePrecedence,
      enabledLanes: routeBlock.enabledLanes,
      deferredLanes: routeBlock.deferredLanes,
      noBackendStarted: routeBlock.noBackendStarted,
      capabilitiesCommand: routeBlock.capabilitiesCommand,
      // Error-teaches (agent-ergonomics Axiom 6): the exact corrected
      // command an agent should retry with, surfaced both on stderr (via
      // formatLaneRouteBlockHuman below) and in the `--json` error
      // envelope's `fix_command`/`error.help` fields
      // (`errorEnvelope.ts#normalizeTopLevelError` reads this key).
      fixCommand: guidance.fixCommand,
    });
    this.name = "LaneRouteBlockError";
    this.routeBlock = routeBlock;
  }
}

export interface LaneBlockGuidance {
  /** One-line, human explanation of *why* this specific reason fired. */
  explanation: string;
  /** Exact, copy-pasteable corrected command. */
  fixCommand: string;
}

const VALID_LANES = ["chatgpt-pro", "fable-local", "gemini-deep-think"] as const;
const GENERIC_FIX_COMMAND =
  'oracle -p "<prompt>" --lane fable-local   # or --lane chatgpt-pro / --lane gemini-deep-think';

/**
 * Maps every `blockedReason` code `resolveLanePolicy` can produce
 * (`lanePolicy.ts`) to a one-line explanation of *why* it fired plus the
 * exact corrected command an agent should retry with. Centralizing this
 * table (rather than leaving the codes bare, as before) is what makes the
 * "unknown lane"/"missing lane" class of route-block genuinely teach the
 * fix instead of just naming a code — see ERROR-REWRITING-COOKBOOK.md.
 */
export function describeLaneBlockReason(routeBlock: LaneRouteBlock): LaneBlockGuidance {
  const reason = routeBlock.blockedReason;
  const attemptedLane = stringField(routeBlock.attemptedRoute, "lane");
  const attemptedModel = stringField(routeBlock.attemptedRoute, "model");
  const attemptedEngine = stringField(routeBlock.attemptedRoute, "engine");

  switch (reason) {
    case "unknown_lane": {
      const suggestion = closestLane(attemptedLane);
      return {
        explanation: `--lane ${JSON.stringify(attemptedLane ?? "")} is not a reviewed lane (valid: ${VALID_LANES.join(", ")}).`,
        fixCommand: suggestion
          ? `oracle -p "<prompt>" --lane ${suggestion}   # closest match to --lane ${attemptedLane}`
          : GENERIC_FIX_COMMAND,
      };
    }
    case "missing_reviewed_lane":
      return {
        explanation: "No reviewed lane, engine, or model was specified.",
        fixCommand: GENERIC_FIX_COMMAND,
      };
    case "fable_requires_fable_local_lane":
    case "claude_code_requires_fable_local_lane":
    case "oracle_engine_claude_code_requires_explicit_lane":
    case "config_engine_claude_code_requires_explicit_lane":
      return {
        explanation: "Claude Code (fable) runs require the explicit reviewed lane flag.",
        fixCommand: 'oracle -p "<prompt>" --lane fable-local',
      };
    case "fable_local_lane_missing":
      return {
        explanation: "The fable-local lane template is unexpectedly missing from the lane registry.",
        fixCommand: "oracle doctor lanes --json",
      };
    case "fable_local_conflicts_with_engine":
      return {
        explanation: `--lane fable-local conflicts with --engine ${attemptedEngine ?? "?"}; fable-local always runs the claude-code engine.`,
        fixCommand: 'oracle -p "<prompt>" --lane fable-local   # drop --engine',
      };
    case "fable_local_conflicts_with_model":
      return {
        explanation: `--lane fable-local conflicts with --model ${attemptedModel ?? "?"}; fable-local always uses the "fable" model.`,
        fixCommand: 'oracle -p "<prompt>" --lane fable-local   # drop --model',
      };
    case "fable_local_requires_local_cli":
      return {
        explanation:
          "--lane fable-local only runs the local `claude` CLI; it cannot be combined with --remote-host/--remote-chrome/--remote-browser.",
        fixCommand: 'oracle -p "<prompt>" --lane fable-local   # drop --remote-*',
      };
    case "fable_local_conflicts_with_browser_flags":
      return {
        explanation:
          "--lane fable-local conflicts with browser-only flags (--browser-*); fable-local never launches a browser.",
        fixCommand: 'oracle -p "<prompt>" --lane fable-local   # drop --browser-*',
      };
    case "fable_local_conflicts_with_api_provider":
      return {
        explanation:
          "--lane fable-local conflicts with API-provider flags (--provider/--base-url/--azure-*); fable-local never calls a hosted API.",
        fixCommand: 'oracle -p "<prompt>" --lane fable-local   # drop --provider/--base-url/--azure-*',
      };
    case "fable_multi_model_fanout_blocked":
    case "multi_model_fanout_blocked":
      return {
        explanation: "--models multi-model fan-out is not supported on reviewed lanes; pick exactly one lane.",
        fixCommand: GENERIC_FIX_COMMAND,
      };
    case "chatgpt_pro_conflicts_with_model":
      return {
        explanation: `--lane chatgpt-pro conflicts with --model ${attemptedModel ?? "?"}; this lane only runs the ChatGPT Pro browser model.`,
        fixCommand: 'oracle -p "<prompt>" --lane chatgpt-pro   # drop --model',
      };
    case "gemini_deep_think_conflicts_with_model":
      return {
        explanation: `--lane gemini-deep-think conflicts with --model ${attemptedModel ?? "?"}; this lane only runs the Gemini 3.1 Deep Think browser model.`,
        fixCommand: 'oracle -p "<prompt>" --lane gemini-deep-think   # drop --model',
      };
    case "chatgpt_pro_conflicts_with_engine":
    case "gemini_deep_think_conflicts_with_engine":
      return {
        explanation: `--lane ${attemptedLane ?? "?"} conflicts with --engine ${attemptedEngine ?? "?"}; drop --engine and let the lane select it.`,
        fixCommand: `oracle -p "<prompt>" --lane ${attemptedLane ?? "chatgpt-pro"}   # drop --engine`,
      };
    case "selector_state_unknown":
      return {
        explanation: "gpt-5.5-pro's browser selector state can't be verified on a legacy (non-lane) route.",
        fixCommand: 'oracle -p "<prompt>" --lane chatgpt-pro',
      };
    case "unsupported_browser_route":
      return {
        explanation: "--engine browser without a reviewed --lane is not a supported route.",
        fixCommand: 'oracle -p "<prompt>" --lane chatgpt-pro   # or --lane gemini-deep-think',
      };
    case "unsupported_api_route":
      return {
        explanation: "The compatibility API / --provider route is not part of the reviewed-lane surface.",
        fixCommand: GENERIC_FIX_COMMAND,
      };
    case "no_active_gemini_lane_or_subscription":
      return {
        explanation: "A gemini-* model was requested without the reviewed Gemini Deep Think lane.",
        fixCommand: 'oracle -p "<prompt>" --lane gemini-deep-think',
      };
    case "unsupported_model_route":
      return {
        explanation: `--model ${attemptedModel ?? "?"} does not map to a reviewed lane.`,
        fixCommand: "oracle capabilities --json   # lists reviewed lanes and their models",
      };
    default:
      return {
        explanation: `Route blocked: ${reason}.`,
        fixCommand: "oracle capabilities --json",
      };
  }
}

export function formatLaneRouteBlockHuman(
  routeBlock: LaneRouteBlock,
  guidance: LaneBlockGuidance = describeLaneBlockReason(routeBlock),
): string {
  const enabled = routeBlock.enabledLanes.map((entry) => `  ${entry.command}`);
  const deferred = routeBlock.deferredLanes.map(
    (entry) => `  ${entry.lane}  ${entry.status}: ${entry.reason}`,
  );
  return [
    "Oracle v1 agent runs are gated to enabled reviewed lanes.",
    `Blocked reason: ${routeBlock.blockedReason} — ${guidance.explanation}`,
    `Your request resolved to: ${JSON.stringify(routeBlock.attemptedRoute)}`,
    `Fix: ${guidance.fixCommand}`,
    "",
    "Enabled now:",
    ...(enabled.length > 0 ? enabled : ["  none"]),
    "",
    "Deferred templates:",
    ...(deferred.length > 0 ? deferred : ["  none"]),
    "",
    "The broader Oracle feature set is still present, but this route is gated for now.",
    `Machine-readable contract: ${routeBlock.capabilitiesCommand}`,
  ].join("\n");
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function closestLane(attempted: string | null): (typeof VALID_LANES)[number] | null {
  if (!attempted) return null;
  let best: (typeof VALID_LANES)[number] | null = null;
  let bestDistance = Infinity;
  for (const candidate of VALID_LANES) {
    const distance = levenshteinDistance(attempted, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  // Only suggest a lane when the typo is plausibly close — otherwise a
  // wildly different value (e.g. "banana") would get a misleading
  // "did you mean" and the generic fallback is more honest.
  const threshold = Math.max(3, Math.ceil((best?.length ?? 0) / 2));
  return best && bestDistance <= threshold ? best : null;
}

function levenshteinDistance(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  const rows = left.length + 1;
  const cols = right.length + 1;
  const distances: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) distances[i][0] = i;
  for (let j = 0; j < cols; j += 1) distances[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      distances[i][j] = Math.min(
        distances[i - 1][j] + 1,
        distances[i][j - 1] + 1,
        distances[i - 1][j - 1] + cost,
      );
    }
  }
  return distances[rows - 1][cols - 1];
}
