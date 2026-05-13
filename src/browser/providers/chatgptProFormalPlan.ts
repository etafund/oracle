import {
  validateChatGptProFormalPlanRoute,
  type ChatGptProFormalPlanRouteDecision,
  type ChatGptProFormalPlanRouteInput,
} from "../formal_plan.js";

export class ChatGptProFormalPlanRouteError extends Error {
  constructor(readonly decision: ChatGptProFormalPlanRouteDecision) {
    super(decision.blockers[0]?.message ?? "ChatGPT Pro formal-plan route is blocked.");
    this.name = "ChatGptProFormalPlanRouteError";
  }
}

export function planChatGptProFormalPlanSubmission(
  input: ChatGptProFormalPlanRouteInput,
): ChatGptProFormalPlanRouteDecision {
  return validateChatGptProFormalPlanRoute(input);
}

export function assertChatGptProFormalPlanReady(
  input: ChatGptProFormalPlanRouteInput,
): ChatGptProFormalPlanRouteDecision {
  const decision = planChatGptProFormalPlanSubmission(input);
  if (!decision.ok) {
    throw new ChatGptProFormalPlanRouteError(decision);
  }
  return decision;
}

export {
  CHATGPT_PRO_FORMAL_PLAN_ROUTE_SCHEMA_VERSION,
  validateChatGptProFormalPlanRoute,
  type ChatGptProBrowserAccessPath,
  type ChatGptProFormalPlanBlocker,
  type ChatGptProFormalPlanRouteDecision,
  type ChatGptProFormalPlanRouteInput,
  type ChatGptProFormalPlanSlot,
  type ChatGptProRemoteBrowserPolicy,
} from "../formal_plan.js";
