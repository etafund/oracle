import { describe, expect, test } from "vitest";

import {
  CLAUDE_CODE_SUBSCRIPTION_CLI,
  CODEX_SUBSCRIPTION_CLI,
  DEEPSEEK_API_ACCESS_PATH,
  ORACLE_BROWSER_REMOTE_OR_LOCAL,
  PROVIDER_BOUNDARIES,
  XAI_API_ACCESS_PATH,
  boundaryForFamily,
  boundaryForSlot,
  summarizeProviderBoundaries,
} from "@src/oracle/v18/provider_boundaries.ts";
import {
  API_ALLOWED_SLOT_ACCESS_PATHS,
  SUBSCRIPTION_CLI_ACCESS_PATHS,
  evaluateApiSubstitution,
  isApiSubstitutionForbidden,
  listApiSubstitutionRules,
} from "@src/oracle/api_substitution_guard.ts";

describe("PROVIDER_BOUNDARIES — static matrix shape", () => {
  test("includes one boundary per advertised family", () => {
    const families = PROVIDER_BOUNDARIES.map((b) => b.family);
    expect(families).toEqual(["chatgpt", "gemini", "claude", "codex", "xai", "deepseek"]);
  });

  test("ChatGPT + Gemini are oracle-owned and forbid API substitution", () => {
    for (const family of ["chatgpt", "gemini"] as const) {
      const boundary = boundaryForFamily(family);
      expect(boundary?.ownership).toBe("oracle");
      expect(boundary?.oracle_owned).toBe(true);
      expect(boundary?.api_substitution_allowed).toBe(false);
      expect(boundary?.evidence_required).toBe(true);
      expect(boundary?.required_access_path).toBe(ORACLE_BROWSER_REMOTE_OR_LOCAL);
    }
  });

  test("Claude routes through claude_code_subscription_cli — not oracle-owned, no API substitution", () => {
    const claude = boundaryForFamily("claude");
    expect(claude?.ownership).toBe("user_cli");
    expect(claude?.oracle_owned).toBe(false);
    expect(claude?.api_substitution_allowed).toBe(false);
    expect(claude?.required_access_path).toBe(CLAUDE_CODE_SUBSCRIPTION_CLI);
    expect(claude?.slots).toContain("claude_code_opus");
    expect(claude?.notes.forbidden_api).toBe("anthropic_api");
  });

  test("Codex routes through codex_subscription_cli with apr_owns_adapter notes", () => {
    const codex = boundaryForFamily("codex");
    expect(codex?.required_access_path).toBe(CODEX_SUBSCRIPTION_CLI);
    expect(codex?.notes.apr_owns_adapter).toBe(true);
    expect(codex?.api_substitution_allowed).toBe(false);
  });

  test("xAI uses xai_api and allows API substitution for its own slot only", () => {
    const xai = boundaryForFamily("xai");
    expect(xai?.ownership).toBe("user_api");
    expect(xai?.oracle_owned).toBe(false);
    expect(xai?.api_substitution_allowed).toBe(true);
    expect(xai?.required_access_path).toBe(XAI_API_ACCESS_PATH);
    expect(xai?.slots).toContain("xai_grok_reasoning");
  });

  test("DeepSeek is explicitly NOT Oracle-owned for this workflow", () => {
    const ds = boundaryForFamily("deepseek");
    expect(ds?.ownership).toBe("user_api");
    expect(ds?.oracle_owned).toBe(false);
    expect(ds?.api_substitution_allowed).toBe(true);
    expect(ds?.required_access_path).toBe(DEEPSEEK_API_ACCESS_PATH);
    expect(ds?.notes.not_oracle_owned_for_workflow).toBe(true);
    expect(ds?.notes.requires_thinking_enabled).toBe(true);
    expect(ds?.notes.requires_reasoning_effort).toBe("max");
    expect(ds?.notes.requires_search_tool).toBe(true);
  });
});

describe("boundaryForSlot — slot lookups", () => {
  test("maps protected slots back to their browser family", () => {
    expect(boundaryForSlot("chatgpt_pro_first_plan")?.family).toBe("chatgpt");
    expect(boundaryForSlot("chatgpt_pro_synthesis")?.family).toBe("chatgpt");
    expect(boundaryForSlot("gemini_deep_think")?.family).toBe("gemini");
  });

  test("maps API-allowed slots back to their family", () => {
    expect(boundaryForSlot("xai_grok_reasoning")?.family).toBe("xai");
    expect(boundaryForSlot("deepseek_v4_pro_reasoning_search")?.family).toBe("deepseek");
  });

  test("maps subscription-CLI slots back to their family", () => {
    expect(boundaryForSlot("claude_code_opus")?.family).toBe("claude");
    expect(boundaryForSlot("codex_intake")?.family).toBe("codex");
  });

  test("returns null for unknown slots", () => {
    expect(boundaryForSlot("does_not_exist")).toBeNull();
  });
});

describe("summarizeProviderBoundaries — provider matrix grouping", () => {
  test("groups by ownership and api-substitution flag", () => {
    const summary = summarizeProviderBoundaries();
    expect(summary.total).toBe(PROVIDER_BOUNDARIES.length);
    expect(summary.oracle_owned).toEqual(["chatgpt", "gemini"]);
    expect(summary.user_cli_owned).toEqual(["claude", "codex"]);
    expect(summary.user_api_owned).toEqual(["xai", "deepseek"]);
    expect(summary.api_substitution_forbidden).toEqual(["chatgpt", "gemini", "claude", "codex"]);
    expect(summary.api_substitution_allowed).toEqual(["xai", "deepseek"]);
  });
});

describe("evaluateApiSubstitution — protected slot rejection", () => {
  test("ChatGPT pro first plan via openai_api is forbidden", () => {
    const verdict = evaluateApiSubstitution({
      slot: "chatgpt_pro_first_plan",
      providerFamily: "openai_api",
      accessPath: "openai_api",
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.some((r) => r.code === "chatgpt_pro_unverified")).toBe(true);
  });

  test("Gemini Deep Think via gemini_api is forbidden", () => {
    const verdict = evaluateApiSubstitution({
      slot: "gemini_deep_think",
      providerFamily: "gemini_api",
      accessPath: "gemini_api",
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.some((r) => r.code === "gemini_deep_think_unverified")).toBe(true);
  });

  test("ChatGPT pro synthesis via oracle_browser_remote is allowed", () => {
    const verdict = evaluateApiSubstitution({
      slot: "chatgpt_pro_synthesis",
      providerFamily: "chatgpt",
      accessPath: "oracle_browser_remote",
    });
    expect(verdict.eligible).toBe(true);
  });
});

describe("evaluateApiSubstitution — subscription-CLI guard (Claude / Codex)", () => {
  test("Claude Code Opus via anthropic_api is forbidden", () => {
    const verdict = evaluateApiSubstitution({
      slot: "claude_code_opus",
      providerFamily: "anthropic_api",
      accessPath: "anthropic_api",
    });
    expect(verdict.eligible).toBe(false);
    expect(
      verdict.reasons.some((r) => r.field === "provider_result.access_path"),
    ).toBe(true);
    expect(verdict.reasons.every((r) => r.code === "provider_login_required")).toBe(true);
  });

  test("Claude Code Opus via claude_code_subscription_cli is allowed", () => {
    const verdict = evaluateApiSubstitution({
      slot: "claude_code_opus",
      providerFamily: "claude",
      accessPath: "claude_code_subscription_cli",
    });
    expect(verdict.eligible).toBe(true);
  });

  test("Codex intake via openai_api is forbidden", () => {
    const verdict = evaluateApiSubstitution({
      slot: "codex_intake",
      providerFamily: "openai_api",
      accessPath: "openai_api",
    });
    expect(verdict.eligible).toBe(false);
  });

  test("Codex via codex_subscription_cli is allowed", () => {
    const verdict = evaluateApiSubstitution({
      slot: "codex_thinking_fast_draft",
      providerFamily: "codex",
      accessPath: "codex_subscription_cli",
    });
    expect(verdict.eligible).toBe(true);
  });
});

describe("evaluateApiSubstitution — API-allowed slots only on their own provider", () => {
  test("xAI slot via xai_api is allowed", () => {
    const verdict = evaluateApiSubstitution({
      slot: "xai_grok_reasoning",
      providerFamily: "xai",
      accessPath: "xai_api",
    });
    expect(verdict.eligible).toBe(true);
  });

  test("xAI slot via DeepSeek API is rejected (cross-family substitution)", () => {
    const verdict = evaluateApiSubstitution({
      slot: "xai_grok_reasoning",
      providerFamily: "deepseek",
      accessPath: "deepseek_api",
    });
    expect(verdict.eligible).toBe(false);
    expect(
      verdict.reasons.some(
        (r) => r.field === "provider_result.access_path" && r.message.includes("xai_api"),
      ),
    ).toBe(true);
  });

  test("DeepSeek slot via xAI API is rejected (cross-family substitution)", () => {
    const verdict = evaluateApiSubstitution({
      slot: "deepseek_v4_pro_reasoning_search",
      providerFamily: "xai",
      accessPath: "xai_api",
    });
    expect(verdict.eligible).toBe(false);
  });

  test("DeepSeek slot via deepseek_api is allowed", () => {
    const verdict = evaluateApiSubstitution({
      slot: "deepseek_v4_pro_reasoning_search",
      providerFamily: "deepseek",
      accessPath: "deepseek_api",
    });
    expect(verdict.eligible).toBe(true);
  });

  test("xAI slot via Oracle browser is rejected (API-allowed slots cannot be browser-routed)", () => {
    const verdict = evaluateApiSubstitution({
      slot: "xai_grok_reasoning",
      providerFamily: "xai",
      accessPath: "oracle_browser_remote",
    });
    expect(verdict.eligible).toBe(false);
  });
});

describe("isApiSubstitutionForbidden — boolean convenience", () => {
  test("returns true for forbidden substitutions", () => {
    expect(
      isApiSubstitutionForbidden({
        slot: "claude_code_opus",
        providerFamily: "anthropic_api",
        accessPath: "anthropic_api",
      }),
    ).toBe(true);
  });

  test("returns false for permitted routes", () => {
    expect(
      isApiSubstitutionForbidden({
        slot: "chatgpt_pro_first_plan",
        providerFamily: "chatgpt",
        accessPath: "oracle_browser_remote",
      }),
    ).toBe(false);
  });

  test("returns false for unknown slots (Oracle does not police outside v18)", () => {
    expect(
      isApiSubstitutionForbidden({
        slot: "some_general_oracle_run",
        providerFamily: "openai_api",
        accessPath: "openai_api",
      }),
    ).toBe(false);
  });
});

describe("listApiSubstitutionRules — surface for capabilities/doctor", () => {
  test("includes every CLI and API-allowed slot, alphabetized", () => {
    const rules = listApiSubstitutionRules();
    const slots = rules.map((r) => r.slot);
    expect(slots).toEqual([...slots].sort());
    expect(slots).toEqual(
      expect.arrayContaining([
        "claude_code_opus",
        "codex_intake",
        "codex_thinking_fast_draft",
        "deepseek_v4_pro_reasoning_search",
        "xai_grok_reasoning",
      ]),
    );
  });

  test("each entry reports the canonical access path", () => {
    const rules = listApiSubstitutionRules();
    for (const rule of rules) {
      if (rule.slot === "claude_code_opus") {
        expect(rule.required_access_path).toBe(
          SUBSCRIPTION_CLI_ACCESS_PATHS.claude_code_opus,
        );
      }
      if (rule.slot === "xai_grok_reasoning") {
        expect(rule.required_access_path).toBe(
          API_ALLOWED_SLOT_ACCESS_PATHS.xai_grok_reasoning,
        );
      }
      if (rule.slot === "deepseek_v4_pro_reasoning_search") {
        expect(rule.required_access_path).toBe(
          API_ALLOWED_SLOT_ACCESS_PATHS.deepseek_v4_pro_reasoning_search,
        );
      }
    }
  });
});
