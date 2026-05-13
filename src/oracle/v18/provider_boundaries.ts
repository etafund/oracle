// Provider boundaries surface — a static matrix of which providers
// Oracle owns end-to-end, which are APR-routed, and which travel
// through caller-side subscription CLIs. Designed for the `oracle
// capabilities --json` envelope and APR's "do I need a new adapter?"
// preflight; not a routing decision engine. Boundary entries are facts
// (the bundle does/does not ship that adapter), so this module is pure
// and stays in lock-step with pane 5's `provider_access_policy`
// constants — see `v18/provider_access_policy.ts`.
//
// Ownership taxonomy:
//
//   "oracle"    — Oracle ships the adapter end-to-end; ChatGPT and
//                 Gemini browser slots live here.
//   "apr"       — APR (vibe-planning) owns the adapter and Oracle
//                 carries only metadata + the API-substitution guard.
//   "user_cli"  — caller-side subscription CLI; Oracle never proxies
//                 the call. Claude Code, Codex.
//   "user_api"  — caller-side API key; Oracle records the request
//                 settings but does not own the adapter for the
//                 protected v18 workflow slot. xAI, DeepSeek.

import {
  API_ALLOWED_SLOTS,
  NON_ORACLE_CLI_SLOTS,
  ORACLE_BROWSER_ACCESS_PATHS,
  PROTECTED_SLOTS,
  PROTECTED_SLOT_FAMILY,
} from "./provider_access_policy.js";

export type ProviderOwnership = "oracle" | "apr" | "user_cli" | "user_api";

export interface ProviderBoundary {
  readonly family: string;
  readonly ownership: ProviderOwnership;
  /** True iff Oracle ships the adapter end-to-end for the protected slot. */
  readonly oracle_owned: boolean;
  /** Whether the v18 workflow forbids API substitution into this family. */
  readonly api_substitution_allowed: boolean;
  /**
   * Canonical access path Oracle records on `provider_result.access_path`
   * for this family's primary slot. Subordinate paths (browser local vs
   * remote, for example) live in `alternative_access_paths`.
   */
  readonly required_access_path: string;
  readonly alternative_access_paths: readonly string[];
  readonly evidence_required: boolean;
  /** v18 workflow slots that belong to this family. */
  readonly slots: readonly string[];
  /** Non-secret notes: env var NAMES, link to selector manifests, etc. */
  readonly notes: Record<string, unknown>;
}

export const ORACLE_BROWSER_REMOTE_OR_LOCAL = "oracle_browser_remote_or_local" as const;
export const CLAUDE_CODE_SUBSCRIPTION_CLI = "claude_code_subscription_cli" as const;
export const CODEX_SUBSCRIPTION_CLI = "codex_subscription_cli" as const;
export const XAI_API_ACCESS_PATH = "xai_api" as const;
export const DEEPSEEK_API_ACCESS_PATH = "deepseek_api" as const;

export const PROVIDER_BOUNDARIES: readonly ProviderBoundary[] = Object.freeze([
  {
    family: "chatgpt",
    ownership: "oracle",
    oracle_owned: true,
    api_substitution_allowed: false,
    required_access_path: ORACLE_BROWSER_REMOTE_OR_LOCAL,
    alternative_access_paths: ORACLE_BROWSER_ACCESS_PATHS,
    evidence_required: true,
    slots: PROTECTED_SLOTS.filter((s) => PROTECTED_SLOT_FAMILY[s] === "chatgpt"),
    notes: {
      reason_for_browser_only:
        "ChatGPT Pro thinking is only available through the browser; the OpenAI API does not expose the same picker label.",
      forbidden_api: "openai_api",
      selector_manifest: "chatgpt-pro-v1",
    },
  },
  {
    family: "gemini",
    ownership: "oracle",
    oracle_owned: true,
    api_substitution_allowed: false,
    required_access_path: ORACLE_BROWSER_REMOTE_OR_LOCAL,
    alternative_access_paths: ORACLE_BROWSER_ACCESS_PATHS,
    evidence_required: true,
    slots: PROTECTED_SLOTS.filter((s) => PROTECTED_SLOT_FAMILY[s] === "gemini"),
    notes: {
      reason_for_browser_only:
        "Gemini Deep Think is exposed only in the browser UI; the Gemini API thinking levels are not the same control surface.",
      forbidden_api: "gemini_api",
      selector_manifest: "gemini-deep-think-v1",
    },
  },
  {
    family: "claude",
    ownership: "user_cli",
    oracle_owned: false,
    api_substitution_allowed: false,
    required_access_path: CLAUDE_CODE_SUBSCRIPTION_CLI,
    alternative_access_paths: [CLAUDE_CODE_SUBSCRIPTION_CLI],
    evidence_required: false,
    slots: NON_ORACLE_CLI_SLOTS.filter((s) => s.startsWith("claude_")),
    notes: {
      reason_for_cli_only:
        "Claude Code Opus uses the user's Claude subscription CLI; an Anthropic API substitution would change pricing and the ultrathink keyword surface.",
      forbidden_api: "anthropic_api",
      apr_owns_adapter: true,
    },
  },
  {
    family: "codex",
    ownership: "user_cli",
    oracle_owned: false,
    api_substitution_allowed: false,
    required_access_path: CODEX_SUBSCRIPTION_CLI,
    alternative_access_paths: [CODEX_SUBSCRIPTION_CLI],
    evidence_required: false,
    slots: NON_ORACLE_CLI_SLOTS.filter((s) => s.startsWith("codex_")),
    notes: {
      reason_for_cli_only:
        "Codex slots run through the OpenAI Codex subscription CLI; Oracle does not proxy these calls.",
      forbidden_api: "openai_api",
      apr_owns_adapter: true,
    },
  },
  {
    family: "xai",
    ownership: "user_api",
    oracle_owned: false,
    api_substitution_allowed: true,
    required_access_path: XAI_API_ACCESS_PATH,
    alternative_access_paths: [XAI_API_ACCESS_PATH],
    evidence_required: false,
    slots: API_ALLOWED_SLOTS.filter((s) => s.startsWith("xai_")),
    notes: {
      api_env_name: "XAI_API_KEY",
      apr_owns_adapter: true,
      reasoning_effort_max_label: "high",
    },
  },
  {
    family: "deepseek",
    ownership: "user_api",
    oracle_owned: false,
    api_substitution_allowed: true,
    required_access_path: DEEPSEEK_API_ACCESS_PATH,
    alternative_access_paths: [DEEPSEEK_API_ACCESS_PATH],
    evidence_required: false,
    slots: API_ALLOWED_SLOTS.filter((s) => s.startsWith("deepseek_")),
    notes: {
      api_env_name: "DEEPSEEK_API_KEY",
      apr_owns_adapter: true,
      requires_thinking_enabled: true,
      requires_reasoning_effort: "max",
      requires_search_tool: true,
      not_oracle_owned_for_workflow: true,
    },
  },
]);

const BOUNDARY_BY_FAMILY: ReadonlyMap<string, ProviderBoundary> = new Map(
  PROVIDER_BOUNDARIES.map((b) => [b.family, b]),
);

const BOUNDARY_BY_SLOT: ReadonlyMap<string, ProviderBoundary> = (() => {
  const map = new Map<string, ProviderBoundary>();
  for (const boundary of PROVIDER_BOUNDARIES) {
    for (const slot of boundary.slots) {
      map.set(slot, boundary);
    }
  }
  return map;
})();

export function boundaryForFamily(family: string): ProviderBoundary | null {
  return BOUNDARY_BY_FAMILY.get(family) ?? null;
}

export function boundaryForSlot(slot: string): ProviderBoundary | null {
  return BOUNDARY_BY_SLOT.get(slot) ?? null;
}

export interface ProviderBoundaryMatrix {
  readonly total: number;
  readonly oracle_owned: readonly string[];
  readonly apr_owned: readonly string[];
  readonly user_cli_owned: readonly string[];
  readonly user_api_owned: readonly string[];
  readonly api_substitution_allowed: readonly string[];
  readonly api_substitution_forbidden: readonly string[];
}

/** Group the boundaries by ownership for an at-a-glance "provider matrix". */
export function summarizeProviderBoundaries(): ProviderBoundaryMatrix {
  const oracle_owned: string[] = [];
  const apr_owned: string[] = [];
  const user_cli_owned: string[] = [];
  const user_api_owned: string[] = [];
  const api_substitution_allowed: string[] = [];
  const api_substitution_forbidden: string[] = [];

  for (const boundary of PROVIDER_BOUNDARIES) {
    switch (boundary.ownership) {
      case "oracle":
        oracle_owned.push(boundary.family);
        break;
      case "apr":
        apr_owned.push(boundary.family);
        break;
      case "user_cli":
        user_cli_owned.push(boundary.family);
        break;
      case "user_api":
        user_api_owned.push(boundary.family);
        break;
    }
    if (boundary.api_substitution_allowed) {
      api_substitution_allowed.push(boundary.family);
    } else {
      api_substitution_forbidden.push(boundary.family);
    }
  }

  return {
    total: PROVIDER_BOUNDARIES.length,
    oracle_owned,
    apr_owned,
    user_cli_owned,
    user_api_owned,
    api_substitution_allowed,
    api_substitution_forbidden,
  };
}
