# Provider Access Policy and Runtime Invariants

> Bundle version: v18.0.0

This bundle includes `contracts/provider-access-policy.schema.json` and `fixtures/provider-access-policy.json`. Treat them as implementation contracts, not merely documentation.

## Live route policy

| Provider slot               | Required access path              |     API allowed? | Notes                                                                                    |
| --------------------------- | --------------------------------- | ---------------: | ---------------------------------------------------------------------------------------- |
| `codex_intake`              | Codex CLI subscription            |               No | User talks at GPT-5.5 Thinking xHigh or closest verified Codex CLI config. Context only. |
| `codex_thinking_fast_draft` | Codex CLI subscription            |               No | Fast exploratory draft only; never a formal first plan.                                  |
| `chatgpt_pro_first_plan`    | Oracle browser, preferably remote |               No | Required for `balanced` and `audit`. Requires redacted same-session evidence.            |
| `chatgpt_pro_synthesis`     | Oracle browser, preferably remote |               No | Required for `balanced` and `audit`. Requires redacted same-session evidence.            |
| `gemini_deep_think`         | Oracle browser, preferably remote |               No | Requires Deep Think same-session evidence.                                               |
| `claude_code_opus`          | Claude Code CLI/subscription      | No Anthropic API | Optional reviewer unless profile says otherwise.                                         |
| `xai_grok_reasoning`        | xAI API                           |              Yes | Resolve current reasoning model at runtime.                                              |

## Why this policy exists

The workflow is intentionally subscription/browser/CLI based for ChatGPT, Gemini, and Claude because the user's desired capabilities are tied to those product routes. Direct APIs may expose different model families, missing UI modes, different entitlements, or different behavior. Grok is the allowed API exception because the desired route is API-based.

## Implementation rule

Do not silently substitute one access path for another. If a route is unavailable, return a blocked or degraded JSON envelope with `blocked_reason`, `next_command`, `fix_command`, and `retry_safe`.

## v18 DeepSeek provider addition

Bundle version: v18.0.0

Adds `deepseek_v4_pro_reasoning_search` as a default optional independent comparison-review provider. This route uses the official DeepSeek API with `deepseek-v4-pro`, thinking enabled, `reasoning_effort=max`, and APR-provided web-search tool calls. It is an API-allowed exception like xAI/Grok; it does not weaken the ban on direct API substitution for ChatGPT, Gemini, or Claude.

## v18 API exceptions

The only live planning routes allowed to use direct APIs are:

- `xai_grok_reasoning` through xAI API.
- `deepseek_v4_pro_reasoning_search` through the official DeepSeek API.

This does not permit ChatGPT/OpenAI API, Gemini API, or Anthropic API substitution for their protected routes. DeepSeek must use `deepseek-v4-pro`, thinking enabled, `reasoning_effort=max`, and APR's search tool-call contract.
