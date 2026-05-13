// Protected-slot boundary surface.
//
// Pane 5's `provider_access_policy.ts` already defines which slots are
// protected (chatgpt_pro_first_plan, chatgpt_pro_synthesis,
// gemini_deep_think). This module adds the fail-closed semantics and
// the silent-downgrade detector that oracle-9nh asks for, kept apart
// from `policy.ts` per the bead's domain rules.
//
// Three responsibilities:
//
//   1. Canonical NON_WAIVABLE_PROTECTED_SLOTS list — the same three
//      slots pane 5 marks "protected", restated here so the waiver
//      module can import without circularity.
//   2. Fail-closed profile semantics: balanced/audit fail closed when
//      a protected slot is missing or degraded; fast/offline mark
//      degraded but proceed.
//   3. Silent-downgrade detector — given a provider_result claim,
//      reject any (synthesis_eligible=true, evidence missing/weak)
//      shape so a waiver cannot quietly substitute a lower browser
//      mode for a Pro/Deep-Think result.

import type { V18ErrorCode } from "./json_envelope.js";

export const NON_WAIVABLE_PROTECTED_SLOTS = [
  "chatgpt_pro_first_plan",
  "chatgpt_pro_synthesis",
  "gemini_deep_think",
] as const;
export type NonWaivableProtectedSlot = (typeof NON_WAIVABLE_PROTECTED_SLOTS)[number];

const NON_WAIVABLE_PROTECTED_SLOT_SET: ReadonlySet<string> = new Set(NON_WAIVABLE_PROTECTED_SLOTS);

export function isNonWaivableSlot(slot: unknown): slot is NonWaivableProtectedSlot {
  return typeof slot === "string" && NON_WAIVABLE_PROTECTED_SLOT_SET.has(slot);
}

/**
 * Profile semantics. Balanced/audit fail closed; fast/offline allow
 * degraded-but-visible operation. Unknown profiles are treated as
 * fail-closed by default — explicit opt-in keeps surprises out of CI.
 */
export const FAIL_CLOSED_PROFILES = ["balanced", "audit"] as const;
export type FailClosedProfile = (typeof FAIL_CLOSED_PROFILES)[number];

export const EXPLORATORY_PROFILES = ["fast", "offline"] as const;
export type ExploratoryProfile = (typeof EXPLORATORY_PROFILES)[number];

const FAIL_CLOSED_PROFILE_SET: ReadonlySet<string> = new Set(FAIL_CLOSED_PROFILES);
const EXPLORATORY_PROFILE_SET: ReadonlySet<string> = new Set(EXPLORATORY_PROFILES);

export function profileFailsClosed(profile: string): boolean {
  if (EXPLORATORY_PROFILE_SET.has(profile)) return false;
  return FAIL_CLOSED_PROFILE_SET.has(profile) || !EXPLORATORY_PROFILE_SET.has(profile);
}

export function isExploratoryProfile(profile: string): boolean {
  return EXPLORATORY_PROFILE_SET.has(profile);
}

// ─── Slot presence / absence metadata ────────────────────────────────────────

export type SlotPresence =
  | "present_verified"
  | "present_degraded"
  | "absent"
  | "absent_optional"
  | "blocked";

export interface SlotBoundaryStatus {
  readonly slot: string;
  readonly presence: SlotPresence;
  /** Whether this slot, in this profile, would block synthesis. */
  readonly blocks_synthesis: boolean;
  /** Whether this slot is non-waivable regardless of profile. */
  readonly non_waivable: boolean;
  readonly reasons: readonly DegradationReason[];
}

// ─── Silent-downgrade detector ───────────────────────────────────────────────

export interface DegradationReason {
  readonly code: V18ErrorCode | null;
  readonly field: string;
  readonly message: string;
}

export interface DowngradeInspectionInput {
  readonly slot: string;
  /** Caller-claimed `synthesis_eligible` flag. */
  readonly synthesis_eligible?: boolean;
  /** Caller-claimed `evidence` (object) or null. */
  readonly evidence?: unknown;
  /** Caller-claimed `evidence_id`. */
  readonly evidence_id?: unknown;
  /** Caller-claimed verification fields. */
  readonly reasoning_effort_verified?: boolean;
  readonly observed_reasoning_effort_label?: string;
  readonly selected_effort_is_highest_visible?: boolean;
  readonly effort_rank?: string;
  /** Caller-claimed result text. */
  readonly result_text_sha256?: string;
  readonly result_text_length?: number;
  /** Caller-claimed access path (oracle_browser_remote, openai_api, …). */
  readonly access_path?: string;
}

export interface DowngradeVerdict {
  readonly degraded: boolean;
  readonly synthesis_eligible: boolean;
  readonly reasons: readonly DegradationReason[];
  readonly next_command: string | null;
  readonly fix_command: string | null;
  readonly recover_command: string;
}

const ORACLE_BROWSER_ACCESS_PATHS = new Set([
  "oracle_browser_remote",
  "oracle_browser_local",
  "oracle_browser_remote_or_local",
]);

const PROTECTED_SLOT_FAMILY: Record<string, "chatgpt" | "gemini"> = {
  chatgpt_pro_first_plan: "chatgpt",
  chatgpt_pro_synthesis: "chatgpt",
  gemini_deep_think: "gemini",
};

function familyUnverifiedCode(slot: string): V18ErrorCode | null {
  const family = PROTECTED_SLOT_FAMILY[slot];
  if (family === "chatgpt") return "chatgpt_pro_unverified";
  if (family === "gemini") return "gemini_deep_think_unverified";
  return null;
}

/**
 * Inspect a provider-result claim for a protected slot and return a
 * downgrade verdict. The detector NEVER trusts `synthesis_eligible`
 * by itself — it cross-checks against the evidence, the access path,
 * and the effort labels. A claim of `synthesis_eligible: true` with
 * missing evidence, unverified reasoning effort, or an API access
 * path is rejected as a silent downgrade.
 *
 * Non-protected slots are passed through unchanged; this detector is
 * only authoritative for the three non-waivable protected slots.
 */
export function detectSilentDowngrade(input: DowngradeInspectionInput): DowngradeVerdict {
  const reasons: DegradationReason[] = [];

  // Only the canonical protected slots are policed here.
  if (!isNonWaivableSlot(input.slot)) {
    return {
      degraded: false,
      synthesis_eligible: input.synthesis_eligible === true,
      reasons,
      next_command: null,
      fix_command: null,
      recover_command: "oracle capabilities --json",
    };
  }
  const code = familyUnverifiedCode(input.slot);

  // 1. Missing evidence outright.
  if (input.evidence == null || input.evidence_id == null) {
    reasons.push({
      code,
      field: "provider_result.evidence",
      message: `protected slot ${input.slot} requires both evidence and evidence_id; got evidence=${
        input.evidence == null ? "missing" : "present"
      }, evidence_id=${input.evidence_id == null ? "missing" : "present"}`,
    });
  }

  // 2. Reasoning effort verification — Pro / Deep Think MUST be verified.
  if (input.reasoning_effort_verified !== true) {
    reasons.push({
      code,
      field: "provider_result.reasoning_effort_verified",
      message: `protected slot ${input.slot} requires reasoning_effort_verified=true`,
    });
  }
  if (
    typeof input.observed_reasoning_effort_label !== "string" ||
    input.observed_reasoning_effort_label.trim().length === 0
  ) {
    reasons.push({
      code,
      field: "provider_result.observed_reasoning_effort_label",
      message: `protected slot ${input.slot} requires a non-empty observed_reasoning_effort_label (picker label)`,
    });
  }

  // 3. Highest-visible effort. ChatGPT pro and Gemini Deep Think both
  //    require the highest visible setting; a lower picker label is a
  //    silent downgrade.
  if (input.selected_effort_is_highest_visible !== true) {
    reasons.push({
      code,
      field: "provider_result.selected_effort_is_highest_visible",
      message: `protected slot ${input.slot} requires selected_effort_is_highest_visible=true`,
    });
  }

  // 4. Access path: must be an Oracle browser path. API substitution
  //    is the headline downgrade we are guarding against.
  if (
    typeof input.access_path === "string" &&
    !ORACLE_BROWSER_ACCESS_PATHS.has(input.access_path)
  ) {
    reasons.push({
      code,
      field: "provider_result.access_path",
      message: `protected slot ${input.slot} forbids API substitution; access_path must be one of ${[
        ...ORACLE_BROWSER_ACCESS_PATHS,
      ].join(", ")} (got "${input.access_path}")`,
    });
  }
  if (input.access_path == null) {
    reasons.push({
      code,
      field: "provider_result.access_path",
      message: `protected slot ${input.slot} requires an explicit Oracle browser access_path`,
    });
  }

  // 5. Empty output. A protected slot can't be synthesis-eligible
  //    with an empty result.
  if (typeof input.result_text_length === "number" && input.result_text_length === 0) {
    reasons.push({
      code: "output_capture_empty",
      field: "provider_result.result_text",
      message: `protected slot ${input.slot} has an empty result_text — synthesis is not eligible`,
    });
  }

  const degraded = reasons.length > 0;
  const synthesisEligible = degraded ? false : input.synthesis_eligible === true;

  return {
    degraded,
    synthesis_eligible: synthesisEligible,
    reasons,
    next_command: degraded ? `oracle doctor ${PROTECTED_SLOT_FAMILY[input.slot]} --json` : null,
    fix_command: degraded
      ? `re-run the protected slot with verified ${PROTECTED_SLOT_FAMILY[input.slot]} browser evidence`
      : null,
    recover_command: degraded
      ? `oracle session <id> --render  # inspect the failed run before retrying`
      : "oracle capabilities --json",
  };
}

/**
 * Assess a single protected slot's presence in the run state. Used by
 * APR / handoff consumers to surface which slot is blocking, whether
 * the absence is acceptable (optional in the current profile), and
 * whether the slot is non-waivable.
 */
export interface AssessSlotInput {
  readonly slot: string;
  readonly profile: string;
  /** Whether the slot produced any result at all. */
  readonly present: boolean;
  /** When present, the downgrade verdict for that result. */
  readonly downgrade?: DowngradeVerdict;
  /** Whether the slot is declared optional by the route plan. */
  readonly optional?: boolean;
}

export function assessProtectedSlot(input: AssessSlotInput): SlotBoundaryStatus {
  const isProtected = isNonWaivableSlot(input.slot);
  const exploratory = isExploratoryProfile(input.profile);
  const reasons: DegradationReason[] = [];

  if (!input.present) {
    // Optional absence in an exploratory profile is fine; in
    // fail-closed profiles, protected slots that are absent block.
    if (input.optional && exploratory) {
      return {
        slot: input.slot,
        presence: "absent_optional",
        blocks_synthesis: false,
        non_waivable: isProtected,
        reasons,
      };
    }
    if (isProtected && profileFailsClosed(input.profile)) {
      reasons.push({
        code: familyUnverifiedCode(input.slot),
        field: "route_readiness.required_slots",
        message: `protected slot ${input.slot} is absent and profile=${input.profile} fails closed`,
      });
      return {
        slot: input.slot,
        presence: "absent",
        blocks_synthesis: true,
        non_waivable: true,
        reasons,
      };
    }
    return {
      slot: input.slot,
      presence: "absent",
      blocks_synthesis: !exploratory,
      non_waivable: isProtected,
      reasons,
    };
  }

  if (input.downgrade?.degraded) {
    reasons.push(...input.downgrade.reasons);
    return {
      slot: input.slot,
      presence: "present_degraded",
      // Non-waivable + degraded = always blocks. Waivable degraded in
      // exploratory profiles surfaces a warning but does not block.
      blocks_synthesis: isProtected || !exploratory,
      non_waivable: isProtected,
      reasons,
    };
  }

  return {
    slot: input.slot,
    presence: "present_verified",
    blocks_synthesis: false,
    non_waivable: isProtected,
    reasons,
  };
}
