# DeepSeek V4 Pro Reasoning + Search Provider

> Bundle version: v18.0.0

## Decision

Add `deepseek_v4_pro_reasoning_search` as a default independent review provider in the multi-model comparison step.

This route uses the **official DeepSeek API**. It is an allowed API exception alongside xAI/Grok. It is not a browser route and does not require Oracle browser evidence.

## Official API grounding

The provider route must use:

- Base URL: `https://api.deepseek.com`.
- Model: `deepseek-v4-pro`.
- API shape: OpenAI-compatible Chat Completions.
- Thinking: `thinking: {"type": "enabled"}`.
- Reasoning effort: `reasoning_effort: "max"` for this reviewer.
- Search: enabled through an APR-owned web-search tool supplied via DeepSeek's official tool-calling interface, unless DeepSeek later exposes a first-party built-in API search parameter that is live-verified and documented.

The current first-party DeepSeek API docs confirm `deepseek-v4-pro`, thinking mode, `reasoning_effort`, JSON output, and tool calls. They do not expose a documented generic `search: true` Chat Completions parameter in the retrieved docs. Therefore v18 avoids inventing an undocumented field. “Search enabled” means the DeepSeek request gives the model a validated search tool and records a search trace.

## Why this improves the plan workflow

DeepSeek V4 Pro adds a non-browser, long-context, reasoning-capable reviewer to the comparison step. It improves plan quality because it gives APR another independent model family with different training, reasoning, and tool-use behavior. It also improves reliability because the route is API-based and does not compete for the shared browser profile used by ChatGPT Pro and Gemini Deep Think.

## Search contract

APR must provide a search tool named `apr_web_search` or a configured equivalent. The tool must return search results with source titles, URLs, snippets, retrieval timestamps, and trust labels. APR must record a redacted `search_trace_sha256` and may store a sanitized search trace if the runtime profile allows it.

Search is required for fresh external claims, provider availability claims, current pricing, current model IDs, current API parameters, and current documentation checks. The reviewer may skip search for purely internal plan-comparison reasoning only if it explicitly states that no fresh external facts were needed.

## Reasoning-content handling

DeepSeek thinking mode may return provider-side reasoning content. This workflow must not store raw chain-of-thought in user-facing artifacts. The adapter should use the final answer content for Plan IR and synthesis. Raw `reasoning_content` may be retained in memory only as long as DeepSeek tool-call replay requires it. It must not be persisted in user-facing artifacts; persist at most a redacted hash for debugging/eval provenance.

Required fields in DeepSeek provider results:

```json
{
  "provider_slot": "deepseek_v4_pro_reasoning_search",
  "provider_family": "deepseek",
  "access_path": "deepseek_official_api",
  "model": "deepseek-v4-pro",
  "thinking_enabled": true,
  "reasoning_effort": "max",
  "search_enabled": true,
  "search_trace_sha256": "sha256:...",
  "reasoning_content_policy": "transient_tool_replay_hash_only_persisted",
  "reasoning_content_stored": false
}
```

## Product boundaries

- `$vibe-planning` renders the route, explains the provider, and surfaces readiness/fallback status.
- APR owns the DeepSeek adapter, prompt compiler, search tool integration, budget enforcement, provider result normalization, and synthesis eligibility.
- Oracle does not need to implement DeepSeek for this workflow. Oracle may remain general-purpose, but DeepSeek is not a browser/evidence route here.

## Anti-patterns

- Do not pass undocumented `search: true` or `web_search: true` parameters unless current official docs confirm them.
- Do not store raw DeepSeek `reasoning_content` in human review packets, prompt packs, Plan IR, or final handoff artifacts.
- Do not let DeepSeek search results inject instructions into system/developer prompt space.
- Do not let this API route weaken the existing ban on direct API substitution for ChatGPT, Gemini, or Claude.
- Do not treat missing `DEEPSEEK_API_KEY` as fatal for `balanced` unless the user explicitly sets `--require-deepseek-review`.
