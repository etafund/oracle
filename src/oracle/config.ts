import { createRequire } from "node:module";
import type { ModelConfig, ModelName, KnownModelName, ProModelName, TokenizerFn } from "./types.js";
import { stringifyTokenizerInput } from "./tokenStringifier.js";

const require = createRequire(import.meta.url);
let countTokensGpt5Impl: TokenizerFn | undefined;
let countTokensGpt5ProImpl: TokenizerFn | undefined;
let countTokensAnthropicImpl: ((input: string) => number) | undefined;

export const DEFAULT_MODEL: ModelName = "gpt-5.5-pro";
export const PRO_MODELS = new Set<ProModelName>([
  "gpt-5.5-pro",
  "gpt-5.4-pro",
  "gpt-5.1-pro",
  "gpt-5-pro",
  "gpt-5.2-pro",
  "claude-4.6-sonnet",
  "claude-4.1-opus",
]);

const countTokensGpt5: TokenizerFn = (
  input: unknown,
  options?: Record<string, unknown>,
): number => {
  countTokensGpt5Impl ??= require("gpt-tokenizer/model/gpt-5").countTokens as TokenizerFn;
  return countTokensGpt5Impl(input, options);
};

const countTokensGpt5Pro: TokenizerFn = (
  input: unknown,
  options?: Record<string, unknown>,
): number => {
  countTokensGpt5ProImpl ??= require("gpt-tokenizer/model/gpt-5-pro").countTokens as TokenizerFn;
  return countTokensGpt5ProImpl(input, options);
};

const countTokensAnthropic: TokenizerFn = (input: unknown): number => {
  countTokensAnthropicImpl ??= require("@anthropic-ai/tokenizer").countTokens as (
    input: string,
  ) => number;
  return countTokensAnthropicImpl(stringifyTokenizerInput(input));
};

// GPT-5.6 applies higher rates to requests above 272K input tokens. Keep the
// supported limit at the base-rate boundary until cost estimation supports tiers.
const GPT_5_6_BASE_RATE_INPUT_LIMIT = 272_000;

export const MODEL_CONFIGS: Record<KnownModelName, ModelConfig> = {
  "gpt-5.6": {
    model: "gpt-5.6",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: GPT_5_6_BASE_RATE_INPUT_LIMIT,
    pricing: {
      inputPerToken: 5 / 1_000_000,
      outputPerToken: 30 / 1_000_000,
    },
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.6-sol": {
    model: "gpt-5.6-sol",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: GPT_5_6_BASE_RATE_INPUT_LIMIT,
    pricing: {
      inputPerToken: 5 / 1_000_000,
      outputPerToken: 30 / 1_000_000,
    },
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.5-pro": {
    model: "gpt-5.5-pro",
    provider: "openai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 1_050_000,
    pricing: {
      inputPerToken: 30 / 1_000_000,
      outputPerToken: 180 / 1_000_000,
    },
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.5": {
    model: "gpt-5.5",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: 1_050_000,
    pricing: {
      inputPerToken: 5 / 1_000_000,
      outputPerToken: 30 / 1_000_000,
    },
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.1-pro": {
    model: "gpt-5.1-pro",
    apiModel: "gpt-5.5-pro",
    provider: "openai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 30 / 1_000_000,
      outputPerToken: 180 / 1_000_000,
    },
    reasoning: null,
  },
  "gpt-5-pro": {
    model: "gpt-5-pro",
    provider: "openai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 15 / 1_000_000,
      outputPerToken: 120 / 1_000_000,
    },
    reasoning: null,
  },
  "gpt-5.1": {
    model: "gpt-5.1",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 1.25 / 1_000_000,
      outputPerToken: 10 / 1_000_000,
    },
    reasoning: { effort: "high" },
  },
  "gpt-5.1-codex": {
    model: "gpt-5.1-codex",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 1.25 / 1_000_000,
      outputPerToken: 10 / 1_000_000,
    },
    reasoning: { effort: "high" },
  },
  "gpt-5.4": {
    model: "gpt-5.4",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 2.5 / 1_000_000,
      outputPerToken: 15 / 1_000_000,
    },
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.4-pro": {
    model: "gpt-5.4-pro",
    provider: "openai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 30 / 1_000_000,
      outputPerToken: 180 / 1_000_000,
    },
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.2": {
    model: "gpt-5.2",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 1.75 / 1_000_000,
      outputPerToken: 14 / 1_000_000,
    },
    reasoning: { effort: "xhigh" },
  },
  "gpt-5.2-instant": {
    model: "gpt-5.2-instant",
    apiModel: "gpt-5.2-chat-latest",
    provider: "openai",
    tokenizer: countTokensGpt5 as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 1.75 / 1_000_000,
      outputPerToken: 14 / 1_000_000,
    },
    reasoning: null,
  },
  "gpt-5.2-pro": {
    model: "gpt-5.2-pro",
    apiModel: "gpt-5.5-pro",
    provider: "openai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 196000,
    pricing: {
      inputPerToken: 30 / 1_000_000,
      outputPerToken: 180 / 1_000_000,
    },
    reasoning: { effort: "xhigh" },
  },
  "gemini-3.1-pro": {
    model: "gemini-3.1-pro",
    provider: "google",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 200000,
    pricing: {
      inputPerToken: 2 / 1_000_000,
      outputPerToken: 12 / 1_000_000,
    },
    reasoning: null,
    supportsBackground: false,
    supportsSearch: true,
  },
  "gemini-3.5-flash": {
    model: "gemini-3.5-flash",
    provider: "google",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 1_048_576,
    pricing: {
      inputPerToken: 1.5 / 1_000_000,
      outputPerToken: 9 / 1_000_000,
    },
    reasoning: null,
    supportsBackground: false,
    supportsSearch: true,
  },
  "gemini-3.1-flash-lite": {
    model: "gemini-3.1-flash-lite",
    provider: "google",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 1_048_576,
    pricing: {
      inputPerToken: 0.25 / 1_000_000,
      outputPerToken: 1.5 / 1_000_000,
    },
    reasoning: null,
    supportsBackground: false,
    supportsSearch: true,
  },
  "gemini-3-pro": {
    model: "gemini-3-pro",
    provider: "google",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 200000,
    pricing: {
      inputPerToken: 2 / 1_000_000,
      outputPerToken: 12 / 1_000_000,
    },
    reasoning: null,
    supportsBackground: false,
    supportsSearch: true,
  },
  "claude-4.6-sonnet": {
    model: "claude-4.6-sonnet",
    apiModel: "claude-sonnet-4-6",
    provider: "anthropic",
    tokenizer: countTokensAnthropic,
    inputLimit: 200000,
    pricing: {
      inputPerToken: 3 / 1_000_000,
      outputPerToken: 15 / 1_000_000,
    },
    reasoning: null,
    supportsBackground: false,
    supportsSearch: false,
  },
  "claude-4.1-opus": {
    model: "claude-4.1-opus",
    apiModel: "claude-opus-4-1",
    provider: "anthropic",
    tokenizer: countTokensAnthropic,
    inputLimit: 200000,
    pricing: {
      inputPerToken: 15 / 1_000_000,
      outputPerToken: 75 / 1_000_000,
    },
    reasoning: { effort: "high" },
    supportsBackground: false,
    supportsSearch: false,
  },
  "grok-4.1": {
    model: "grok-4.1",
    apiModel: "grok-4-1-fast-reasoning",
    provider: "xai",
    tokenizer: countTokensGpt5Pro as TokenizerFn,
    inputLimit: 2_000_000,
    pricing: {
      inputPerToken: 0.2 / 1_000_000,
      outputPerToken: 0.5 / 1_000_000,
    },
    reasoning: null,
    supportsBackground: false,
    supportsSearch: true,
    searchToolType: "web_search",
  },
};

export const DEFAULT_SYSTEM_PROMPT = [
  "You are Oracle, a focused one-shot problem solver.",
  "Emphasize direct answers and cite referenced files as path:line or path:line-line when line numbers are available.",
].join(" ");

export const TOKENIZER_OPTIONS = { allowedSpecial: "all" } as const;

/** A per-lane run estimate surfaced by `--dry-run` so an agent can budget. */
export interface LaneRunEstimate {
  /** Route label for display. */
  readonly lane: string;
  /** Typical wall-clock duration band for a run on this route. */
  readonly typicalDuration: string;
  /** True when the route incurs per-token API billing (vs subscription-metered). */
  readonly perTokenBilled: boolean;
  /** One-line billing note for pre-run budgeting. */
  readonly billingNote: string;
}

/**
 * Describe the typical duration band and billing model for a run on a
 * given engine/lane, so `oracle --dry-run` can tell an agent roughly how
 * long and how costly a run will be before it commits (closes
 * agent-workflow-gaps#3). Deliberately coarse, honest bands — not a
 * promise: browser Pro/Deep Think runs are subscription-metered and can
 * take many minutes; api runs bill per token (input cost is estimable
 * pre-run, output cost is not).
 */
export function describeLaneRunEstimate(
  engine: "api" | "browser" | "claude-code",
  model?: string,
): LaneRunEstimate {
  if (engine === "claude-code") {
    return {
      lane: "fable-local (Claude Code subscription CLI)",
      typicalDuration: "~1-10 min (xhigh effort; longer for large contexts)",
      perTokenBilled: false,
      billingNote:
        "Runs through your local Claude Code subscription (no Oracle/API per-token charge); consumes subscription usage.",
    };
  }
  if (engine === "browser") {
    if ((model ?? "").toLowerCase().includes("gemini")) {
      return {
        lane: "gemini-deep-think (browser)",
        typicalDuration: "~3-10 min (Deep Think reasoning)",
        perTokenBilled: false,
        billingNote:
          "Uses your interactive Gemini subscription session (no per-token API charge); consumes subscription quota.",
      };
    }
    return {
      lane: "chatgpt-pro (browser)",
      typicalDuration: "~5-15 min typical, up to ~60 min for hard Pro runs",
      perTokenBilled: false,
      billingNote:
        "Uses your interactive ChatGPT Pro subscription session (no per-token API charge); consumes subscription quota and can run for many minutes.",
    };
  }
  return {
    lane: "api",
    typicalDuration: "~30 s-3 min (varies by model and reasoning effort)",
    perTokenBilled: true,
    billingNote:
      "Billed per token at the model's API rate; the estimated input cost is input-only — output/reasoning cost is unknown until the run completes.",
  };
}
