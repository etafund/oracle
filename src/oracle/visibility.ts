import {
  budgetVerdict,
  consumeBudget,
  createBudgetTracker,
  estimateSlotRuntime,
  isApprovalSatisfied,
  type BudgetTrackerState,
  type BudgetVerdict,
  type SlotRuntimeEstimate,
} from "./runtime_budget.js";
import { V18_BUNDLE_VERSION, createEnvelope, type JsonEnvelope } from "./v18/index.js";
import { isNonWaivableSlot } from "./v18/protected_slot_boundaries.js";
import { buildWaiverHandoffMetadata, type WaiverHandoffMetadata } from "./v18/waiver.js";

export const ORACLE_VISIBILITY_STATUS_SCHEMA_VERSION = "oracle_visibility_status.v1" as const;

export type VisibilityComponentStatus = "pass" | "warn" | "fail" | "unknown";
export type PremortemVisibilityStatus = "covered" | "missing" | "blocked" | "unknown";

export interface VisibilityBudgetInput {
  readonly budget?: unknown;
  readonly consumedWallMs?: number;
  readonly consumedCostUsd?: number;
  readonly consumedTokens?: number;
  readonly approvalsPresent?: readonly string[];
}

export interface PremortemVisibilityInput {
  readonly id: string;
  readonly title?: string;
  readonly status: PremortemVisibilityStatus;
  readonly owner?: string;
  readonly next_command?: string | null;
  readonly fix_command?: string | null;
}

export interface BuildOracleVisibilityStatusInput {
  readonly profile: string;
  readonly slot: string;
  readonly now?: Date;
  readonly budget?: VisibilityBudgetInput;
  readonly waiver?: unknown;
  readonly premortem?: readonly PremortemVisibilityInput[];
}

export interface VisibilityComponent {
  readonly name: "runtime_budget" | "waiver" | "premortem";
  readonly status: VisibilityComponentStatus;
  readonly code: string;
  readonly message: string;
  readonly next_command: string | null;
  readonly fix_command: string | null;
  readonly retry_safe: boolean;
  readonly details: Record<string, unknown>;
}

export interface VisibilityBudgetSummary {
  readonly present: boolean;
  readonly error: string | null;
  readonly verdict: BudgetVerdict | null;
  readonly approvals: {
    readonly required: readonly string[];
    readonly missing: readonly string[];
    readonly satisfied: boolean;
  };
  readonly estimate: SlotRuntimeEstimate | null;
}

export interface PremortemVisibilitySummary {
  readonly total: number;
  readonly covered: number;
  readonly missing: number;
  readonly blocked: number;
  readonly unknown: number;
  readonly modes: readonly PremortemVisibilityInput[];
}

export interface OracleVisibilityStatusPayload {
  readonly schema_version: typeof ORACLE_VISIBILITY_STATUS_SCHEMA_VERSION;
  readonly bundle_version: typeof V18_BUNDLE_VERSION;
  readonly generated_at: string;
  readonly profile: string;
  readonly slot: string;
  readonly status: "ready" | "blocked" | "degraded" | "unknown";
  readonly components: readonly VisibilityComponent[];
  readonly budget: VisibilityBudgetSummary;
  readonly waiver: WaiverHandoffMetadata & {
    readonly non_waivable_slot: boolean;
  };
  readonly premortem: PremortemVisibilitySummary;
}

export interface OracleVisibilityStatusResult {
  readonly envelope: JsonEnvelope;
  readonly payload: OracleVisibilityStatusPayload;
}

export function buildOracleVisibilityStatus(
  input: BuildOracleVisibilityStatusInput,
): OracleVisibilityStatusResult {
  const now = input.now ?? new Date();
  const budget = buildBudgetSummary(input, now);
  const waiver = {
    ...buildWaiverHandoffMetadata(input.waiver, {
      slot: input.slot,
      profile: input.profile,
      now,
    }),
    non_waivable_slot: isNonWaivableSlot(input.slot),
  };
  const premortem = buildPremortemSummary(input.premortem ?? []);
  const components = [
    budgetComponent(budget),
    waiverComponent(waiver),
    premortemComponent(premortem),
  ] as const;
  const failures = components.filter((component) => component.status === "fail");
  const warnings = components.filter(
    (component) => component.status === "warn" || component.status === "unknown",
  );
  const status =
    failures.length > 0
      ? "blocked"
      : warnings.some((component) => component.status === "warn")
        ? "degraded"
        : warnings.some((component) => component.status === "unknown")
          ? "unknown"
          : "ready";
  const payload: OracleVisibilityStatusPayload = {
    schema_version: ORACLE_VISIBILITY_STATUS_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    generated_at: now.toISOString(),
    profile: input.profile,
    slot: input.slot,
    status,
    components,
    budget,
    waiver,
    premortem,
  };
  const headline = failures[0] ?? warnings[0] ?? null;
  return {
    payload,
    envelope: createEnvelope({
      ok: failures.length === 0,
      data: payload as unknown as JsonEnvelope["data"],
      meta: {
        schema_version: ORACLE_VISIBILITY_STATUS_SCHEMA_VERSION,
        bundle_version: V18_BUNDLE_VERSION,
        generated_at: payload.generated_at,
        profile: input.profile,
        slot: input.slot,
      },
      blocked_reason: failures[0]?.code ?? null,
      next_command: headline?.next_command ?? null,
      fix_command: headline?.fix_command ?? null,
      retry_safe: headline?.retry_safe ?? null,
      warnings: warnings.map((component) => component.message),
      commands: {
        preview: "oracle preview --json",
        premortem: "rch exec -- pnpm vitest run tests/premortem/v18",
        capabilities: "oracle capabilities --json",
      },
    }),
  };
}

function buildBudgetSummary(
  input: BuildOracleVisibilityStatusInput,
  now: Date,
): VisibilityBudgetSummary {
  const estimate = estimateSlotRuntime(input.slot);
  if (!input.budget?.budget) {
    return {
      present: false,
      error: null,
      verdict: null,
      approvals: { required: [], missing: [], satisfied: true },
      estimate,
    };
  }

  let tracker: BudgetTrackerState;
  try {
    tracker = createBudgetTracker({ budget: input.budget.budget, now });
  } catch (error) {
    return {
      present: true,
      error: error instanceof Error ? error.message : String(error),
      verdict: null,
      approvals: { required: [], missing: [], satisfied: false },
      estimate,
    };
  }
  const consumed = consumeBudget(tracker, {
    wallMs: input.budget.consumedWallMs,
    costUsd: input.budget.consumedCostUsd,
    tokens: input.budget.consumedTokens,
  });
  const approval = isApprovalSatisfied(input.budget.budget, input.budget.approvalsPresent ?? []);
  const required =
    typeof input.budget.budget === "object" &&
    input.budget.budget != null &&
    Array.isArray((input.budget.budget as Record<string, unknown>).required_approvals)
      ? ((input.budget.budget as Record<string, unknown>).required_approvals as string[])
      : [];
  return {
    present: true,
    error: null,
    verdict: budgetVerdict(consumed as BudgetTrackerState),
    approvals: {
      required,
      missing: approval.missing,
      satisfied: approval.satisfied,
    },
    estimate,
  };
}

function buildPremortemSummary(
  modes: readonly PremortemVisibilityInput[],
): PremortemVisibilitySummary {
  return {
    total: modes.length,
    covered: modes.filter((mode) => mode.status === "covered").length,
    missing: modes.filter((mode) => mode.status === "missing").length,
    blocked: modes.filter((mode) => mode.status === "blocked").length,
    unknown: modes.filter((mode) => mode.status === "unknown").length,
    modes: [...modes],
  };
}

function budgetComponent(summary: VisibilityBudgetSummary): VisibilityComponent {
  if (!summary.present) {
    return component({
      name: "runtime_budget",
      status: "unknown",
      code: "runtime_budget_missing",
      message: "No runtime_budget.v1 payload was supplied for this status check.",
      next_command: "oracle preview --json",
      fix_command: "Pass an APR runtime_budget.v1 payload before starting live work.",
      retry_safe: true,
      details: { estimate: summary.estimate },
    });
  }
  if (summary.error) {
    return component({
      name: "runtime_budget",
      status: "fail",
      code: "runtime_budget_invalid",
      message: "runtime_budget.v1 payload is invalid.",
      next_command: "oracle preview --json",
      fix_command: "Provide a valid runtime_budget.v1 payload.",
      retry_safe: true,
      details: { error: summary.error, estimate: summary.estimate },
    });
  }
  if (!summary.approvals.satisfied) {
    return component({
      name: "runtime_budget",
      status: "fail",
      code: "runtime_budget_approval_missing",
      message: `Required approvals missing: ${summary.approvals.missing.join(", ")}`,
      next_command: "oracle preview --json",
      fix_command: `Record approvals: ${summary.approvals.missing.join(", ")}`,
      retry_safe: true,
      details: { approvals: summary.approvals, verdict: summary.verdict },
    });
  }
  if (summary.verdict?.status === "exhausted") {
    return component({
      name: "runtime_budget",
      status: "fail",
      code: "runtime_budget_exhausted",
      message: summary.verdict.reasons[0] ?? "Runtime budget is exhausted.",
      next_command: "oracle preview --json",
      fix_command: "Increase APR runtime budget or stop this live route.",
      retry_safe: false,
      details: { approvals: summary.approvals, verdict: summary.verdict },
    });
  }
  if (summary.verdict?.status === "near_exhaustion") {
    return component({
      name: "runtime_budget",
      status: "warn",
      code: "runtime_budget_near_exhaustion",
      message: summary.verdict.reasons[0] ?? "Runtime budget is near exhaustion.",
      next_command: "oracle preview --json",
      fix_command: null,
      retry_safe: true,
      details: { approvals: summary.approvals, verdict: summary.verdict },
    });
  }
  return component({
    name: "runtime_budget",
    status: "pass",
    code: "runtime_budget_visible",
    message: "Runtime budget and approval state are visible.",
    next_command: null,
    fix_command: null,
    retry_safe: true,
    details: { approvals: summary.approvals, verdict: summary.verdict, estimate: summary.estimate },
  });
}

function waiverComponent(
  waiver: WaiverHandoffMetadata & { readonly non_waivable_slot: boolean },
): VisibilityComponent {
  if (!waiver.waiver_attempted) {
    return component({
      name: "waiver",
      status: "pass",
      code: "waiver_not_attempted",
      message: "No waiver was attempted.",
      next_command: null,
      fix_command: null,
      retry_safe: true,
      details: { non_waivable_slot: waiver.non_waivable_slot },
    });
  }
  if (!waiver.waiver_applicable) {
    return component({
      name: "waiver",
      status: waiver.non_waivable_slot ? "fail" : "warn",
      code: waiver.non_waivable_slot ? "waiver_non_waivable_slot" : "waiver_rejected_visible",
      message: waiver.non_waivable_slot
        ? "Waiver attempt targets a non-waivable protected slot."
        : "Rejected waiver attempt is visible in handoff metadata.",
      next_command: "oracle capabilities --json",
      fix_command: "Remove the waiver or route through APR with an eligible optional slot.",
      retry_safe: false,
      details: { waiver },
    });
  }
  return component({
    name: "waiver",
    status: "warn",
    code: "waiver_applied_visible",
    message: "Applicable waiver is visible and must remain surfaced in handoff metadata.",
    next_command: null,
    fix_command: null,
    retry_safe: true,
    details: { waiver },
  });
}

function premortemComponent(summary: PremortemVisibilitySummary): VisibilityComponent {
  if (summary.total === 0) {
    return component({
      name: "premortem",
      status: "unknown",
      code: "premortem_status_missing",
      message: "No premortem failure-mode status was supplied.",
      next_command: "rch exec -- pnpm vitest run tests/premortem/v18",
      fix_command: "Attach premortem failure-mode status to the visibility envelope.",
      retry_safe: true,
      details: { premortem: summary },
    });
  }
  if (summary.blocked > 0 || summary.missing > 0) {
    return component({
      name: "premortem",
      status: "fail",
      code: summary.blocked > 0 ? "premortem_release_gate_blocked" : "premortem_coverage_missing",
      message:
        summary.blocked > 0
          ? "One or more premortem failure modes are blocked."
          : "One or more premortem failure modes are missing coverage.",
      next_command: "rch exec -- pnpm vitest run tests/premortem/v18",
      fix_command: "Add or repair the missing premortem control before release.",
      retry_safe: true,
      details: { premortem: summary },
    });
  }
  if (summary.unknown > 0) {
    return component({
      name: "premortem",
      status: "warn",
      code: "premortem_status_unknown",
      message: "One or more premortem failure modes have unknown status.",
      next_command: "rch exec -- pnpm vitest run tests/premortem/v18",
      fix_command: null,
      retry_safe: true,
      details: { premortem: summary },
    });
  }
  return component({
    name: "premortem",
    status: "pass",
    code: "premortem_controls_visible",
    message: "Premortem failure-mode controls are represented.",
    next_command: null,
    fix_command: null,
    retry_safe: true,
    details: { premortem: summary },
  });
}

function component(input: VisibilityComponent): VisibilityComponent {
  return input;
}
