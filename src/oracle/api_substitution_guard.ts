// API-substitution guard.
//
// Layers on top of pane 5's `evaluateSlotAccess` to add the two
// substitution rules pane 5 does not cover yet:
//
//   * Non-Oracle subscription-CLI slots (`claude_code_*`, `codex_*`)
//     MUST resolve through their subscription CLI, never through the
//     provider's REST API. An Anthropic-API or OpenAI-API call against
//     `claude_code_opus` would change pricing and lose the
//     `ultrathink` keyword surface, so the guard rejects it.
//   * API-allowed slots (`xai_*`, `deepseek_*`) MUST resolve through
//     THEIR provider's API only — calling the xAI API to satisfy a
//     DeepSeek slot, or vice versa, is also a substitution.
//
// Pane 5's primitive already rejects every protected ChatGPT / Gemini
// API substitution and every Oracle-browser-misrouted API-allowed
// slot. We defer to it first and only add reasons; we never weaken its
// verdict. The combined guard is what `oracle capabilities` callers
// and APR's adapter probes use as the single decision boundary.

import {
  API_ALLOWED_SLOTS,
  NON_ORACLE_CLI_SLOTS,
  evaluateSlotAccess,
  isApiAllowedSlot,
  isNonOracleCliSlot,
  type AccessEligibilityVerdict,
  type AccessReason,
  type SlotAccessInputs,
} from "./v18/provider_access_policy.js";
import type { V18ErrorCode } from "./v18/json_envelope.js";

/**
 * Required `provider_result.access_path` value for each
 * subscription-CLI slot. These are not Oracle-owned routes — Oracle
 * only records the chosen access path; APR or the caller owns the
 * adapter.
 */
export const SUBSCRIPTION_CLI_ACCESS_PATHS = Object.freeze({
  claude_code_opus: "claude_code_subscription_cli",
  codex_intake: "codex_subscription_cli",
  codex_thinking_fast_draft: "codex_subscription_cli",
} as const satisfies Record<(typeof NON_ORACLE_CLI_SLOTS)[number], string>);

/**
 * Required `provider_result.access_path` for each API-allowed slot.
 * APR-owned routes — same constraint: the chosen path must match.
 */
export const API_ALLOWED_SLOT_ACCESS_PATHS = Object.freeze({
  xai_grok_reasoning: "xai_api",
  deepseek_v4_pro_reasoning_search: "deepseek_api",
} as const satisfies Record<(typeof API_ALLOWED_SLOTS)[number], string>);

const CLI_SLOT_FAMILY: Record<(typeof NON_ORACLE_CLI_SLOTS)[number], string> = {
  claude_code_opus: "claude",
  codex_intake: "codex",
  codex_thinking_fast_draft: "codex",
};

const API_ALLOWED_SLOT_FAMILY: Record<(typeof API_ALLOWED_SLOTS)[number], string> = {
  xai_grok_reasoning: "xai",
  deepseek_v4_pro_reasoning_search: "deepseek",
};

/** Reusable input shape — matches pane 5's primitive so callers can share types. */
export type ApiSubstitutionInputs = SlotAccessInputs;

const OK_VERDICT: AccessEligibilityVerdict = Object.freeze({ eligible: true, reasons: [] });

function buildVerdict(reasons: AccessReason[]): AccessEligibilityVerdict {
  return reasons.length === 0 ? OK_VERDICT : { eligible: false, reasons };
}

/**
 * Decide whether (slot, provider_family, access_path) is a permitted
 * route. Stricter than `evaluateSlotAccess`: also rejects Claude/Codex
 * subscription-CLI bypasses and xAI↔DeepSeek API misroutes.
 *
 * `provider_family` and `access_path` are compared case-sensitively;
 * the v18 fixtures use lowercased identifiers everywhere.
 */
export function evaluateApiSubstitution(
  inputs: ApiSubstitutionInputs,
): AccessEligibilityVerdict {
  // Pane 5's primitive owns the ChatGPT / Gemini / API-allowed-via-browser
  // rules. Defer to it first; if it already blocked the route, surface
  // those reasons verbatim.
  const v18 = evaluateSlotAccess(inputs);
  const reasons: AccessReason[] = [...v18.reasons];

  if (isNonOracleCliSlot(inputs.slot)) {
    const requiredPath = SUBSCRIPTION_CLI_ACCESS_PATHS[inputs.slot];
    const requiredFamily = CLI_SLOT_FAMILY[inputs.slot];
    if (inputs.accessPath !== requiredPath) {
      reasons.push({
        code: "provider_login_required" satisfies V18ErrorCode,
        field: "provider_result.access_path",
        message: `slot ${inputs.slot} requires access_path="${requiredPath}" (subscription CLI); got "${inputs.accessPath}" — API substitution is forbidden for non-Oracle CLI slots.`,
      });
    }
    if (inputs.providerFamily !== requiredFamily) {
      reasons.push({
        code: "provider_login_required" satisfies V18ErrorCode,
        field: "provider_result.provider_family",
        message: `slot ${inputs.slot} requires provider_family="${requiredFamily}"; got "${inputs.providerFamily}".`,
      });
    }
  }

  if (isApiAllowedSlot(inputs.slot)) {
    const requiredPath = API_ALLOWED_SLOT_ACCESS_PATHS[inputs.slot];
    const requiredFamily = API_ALLOWED_SLOT_FAMILY[inputs.slot];
    // Pane 5 already blocks Oracle-browser misroutes for API-allowed
    // slots. Add the cross-family API misroute (xAI key calling
    // DeepSeek slot or vice versa).
    if (inputs.accessPath !== requiredPath) {
      reasons.push({
        code: null,
        field: "provider_result.access_path",
        message: `slot ${inputs.slot} requires access_path="${requiredPath}"; got "${inputs.accessPath}" — API-allowed slots may only be satisfied by their own provider API.`,
      });
    }
    if (inputs.providerFamily !== requiredFamily) {
      reasons.push({
        code: null,
        field: "provider_result.provider_family",
        message: `slot ${inputs.slot} requires provider_family="${requiredFamily}"; got "${inputs.providerFamily}".`,
      });
    }
  }

  // De-duplicate reasons (pane 5 + our reasons can both flag the same
  // field for an API-allowed-via-browser misroute).
  const seen = new Set<string>();
  const deduped: AccessReason[] = [];
  for (const reason of reasons) {
    const key = `${reason.field}::${reason.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(reason);
  }

  return buildVerdict(deduped);
}

export function isApiSubstitutionForbidden(inputs: ApiSubstitutionInputs): boolean {
  return !evaluateApiSubstitution(inputs).eligible;
}

/**
 * Compact decision record for `oracle capabilities --json` / the
 * aggregate doctor surface. Lists every slot the guard understands
 * and what a permitted (slot, family, access_path) triple looks like.
 */
export interface ApiSubstitutionRuleEntry {
  readonly slot: string;
  readonly required_provider_family: string;
  readonly required_access_path: string;
  readonly api_substitution_forbidden_for_protected_browser_slots: boolean;
}

export function listApiSubstitutionRules(): readonly ApiSubstitutionRuleEntry[] {
  const entries: ApiSubstitutionRuleEntry[] = [];
  for (const slot of NON_ORACLE_CLI_SLOTS) {
    entries.push({
      slot,
      required_provider_family: CLI_SLOT_FAMILY[slot],
      required_access_path: SUBSCRIPTION_CLI_ACCESS_PATHS[slot],
      api_substitution_forbidden_for_protected_browser_slots: true,
    });
  }
  for (const slot of API_ALLOWED_SLOTS) {
    entries.push({
      slot,
      required_provider_family: API_ALLOWED_SLOT_FAMILY[slot],
      required_access_path: API_ALLOWED_SLOT_ACCESS_PATHS[slot],
      api_substitution_forbidden_for_protected_browser_slots: false,
    });
  }
  entries.sort((a, b) => a.slot.localeCompare(b.slot));
  return entries;
}
