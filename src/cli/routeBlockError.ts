import { PromptValidationError } from "../oracle/errors.js";
import type { LaneRouteBlock } from "./lanePolicy.js";

export class LaneRouteBlockError extends PromptValidationError {
  readonly exitCode = 2;
  readonly routeBlock: LaneRouteBlock;

  constructor(routeBlock: LaneRouteBlock) {
    super(formatLaneRouteBlockHuman(routeBlock), {
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
    });
    this.name = "LaneRouteBlockError";
    this.routeBlock = routeBlock;
  }
}

export function formatLaneRouteBlockHuman(routeBlock: LaneRouteBlock): string {
  const enabled = routeBlock.enabledLanes.map((entry) => `  ${entry.command}`);
  const deferred = routeBlock.deferredLanes.map(
    (entry) => `  ${entry.lane}  ${entry.status}: ${entry.reason}`,
  );
  return [
    "Oracle v1 agent runs are gated to enabled reviewed lanes.",
    `Your request resolved to: ${JSON.stringify(routeBlock.attemptedRoute)}`,
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
