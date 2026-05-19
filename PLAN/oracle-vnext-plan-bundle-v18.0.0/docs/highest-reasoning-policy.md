# Highest Reasoning Effort Policy — v18.0.0

This document is part of each standalone v18 subset bundle. It fixes a prior-bundle omission: the plan said to use capable frontier models, but it did not make **highest provider-specific reasoning effort** a first-class invariant for every live model call.

## Product decision

All live model calls in the `$vibe-planning` / APR / Oracle workflow default to the highest documented reasoning or thinking setting available for that provider. A missing, unknown, default, or lower effort is not synthesis-eligible in `balanced` or `audit` unless a human-visible waiver is recorded before the call.

## Provider-specific maximums

| Slot                               | Route                        | Highest-effort setting to request                                                                                                   | Notes                                                                                                                                     |
| ---------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `codex_intake`                     | Codex CLI subscription       | `model_reasoning_effort=xhigh` and `plan_mode_reasoning_effort=xhigh`                                                               | Intake remains context only, not a formal plan.                                                                                           |
| `codex_thinking_fast_draft`        | Codex CLI subscription       | `xhigh`                                                                                                                             | Fast exploratory draft only.                                                                                                              |
| `chatgpt_pro_first_plan`           | Oracle ChatGPT browser       | ChatGPT `Pro` plus highest visible model-picker thinking effort; record `Heavy` only if that is the observed top label              | Oracle must record the exact observed UI label.                                                                                           |
| `chatgpt_pro_synthesis`            | Oracle ChatGPT browser       | Same as first plan                                                                                                                  | Required for balanced/audit synthesis.                                                                                                    |
| `gemini_deep_think`                | Oracle Gemini browser        | `Deep Think`; if a Gemini thinking-level control appears, set `high`                                                                | Gemini 3 API equivalent maximum is `thinking_level=high`, but live workflow uses browser Deep Think.                                      |
| `claude_code_opus`                 | Claude Code subscription CLI | Claude Opus 4.7 with `--effort max` or `CLAUDE_CODE_EFFORT_LEVEL=max`; include `ultrathink` as an additional one-off prompt keyword | Do not use Anthropic API for this workflow.                                                                                               |
| `xai_grok_reasoning`               | xAI API                      | `grok-4.3` with `reasoning_effort=high`                                                                                             | `high` is the maximum single-model Grok 4.3 reasoning effort.                                                                             |
| `deepseek_v4_pro_reasoning_search` | Official DeepSeek API        | `deepseek-v4-pro`, `thinking.type=enabled`, `reasoning_effort=max`                                                                  | Use APR search tool calls. Raw `reasoning_content` may be replayed transiently for tool calls but must not be persisted except as a hash. |

## Why this improves the project

Reasoning effort is not merely a performance knob in this workflow. The product promise is that the planning loop gets the best available reasoning from each provider before comparing and synthesizing implementation plans. Leaving effort at provider defaults silently weakens the comparison, makes plan quality inconsistent, and causes confusing regressions when a provider changes defaults.

## Development rule

Implementers must add effort metadata to provider route plans, provider results, prompt manifests, browser evidence, and human review packets. APR must reject a provider result as synthesis-ineligible when the required highest effort is missing or unverifiable.
