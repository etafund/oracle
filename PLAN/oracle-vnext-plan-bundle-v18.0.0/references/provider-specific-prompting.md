# Provider-Specific Prompting Policy

> Bundle version: v18.0.0

Provider prompting is not generic. The implementation must compile prompts per provider family.

## Codex CLI intake through user subscription

The intake conversation happens in Codex CLI with the user's subscription. Do not route it through Oracle and do not call the OpenAI API. The goal is to let the user externalize messy product intent with GPT-5.5 Thinking xHigh or the closest verified Codex CLI configuration. The output is an intake transcript and normalized brief, not a formal first plan for balanced/audit.

## ChatGPT Pro through Oracle browser automation

Use ChatGPT Pro / the latest Pro model in the ChatGPT web UI for the formal first plan and all later ChatGPT synthesis/revision routes in `balanced` and `audit`. Follow OpenAI's first-party prompt guidance: be clear and specific, place task and context up front, use structured delimiters, and refine iteratively. Because this route is browser-based, a prompt manifest must record the provider family, mode, policy version, source hashes, and redaction decisions. Do not ask for hidden chain-of-thought; ask for a concise rationale, assumptions, tradeoffs, and a verifiable output structure.

## Gemini 3.1 Pro Deep Think through Oracle browser automation

Use Gemini through Oracle browser automation and explicitly enable Deep Think. Follow Google's prompt guidance: use direct prompts, control verbosity, put the decisive question after long context, and ask for structured outputs. Same-session Deep Think verification is mandatory before prompt submission.

## Claude through Claude Code

Use Claude Code CLI/subscription paths for live `$vibe-planning` planning, not Anthropic API calls. Follow Anthropic prompting guidance: define success criteria first, use clear XML-style or section delimiters, provide examples when helpful, and ask Claude to evaluate against the rubric before proposing changes.

## Grok through xAI API

Grok and DeepSeek are the allowed API exceptions. Resolve the current xAI reasoning model at runtime, prefer structured outputs, and request high reasoning effort for complex plan review. Treat legacy names such as `Grok Heavy` as workflow aliases, not static model IDs.

## DeepSeek V4 Pro through official DeepSeek API

DeepSeek is an allowed API route for the independent comparison-review step. Use `deepseek-v4-pro` through the official DeepSeek API with `thinking: {"type":"enabled"}` and `reasoning_effort: "max"`. Enable search by providing APR's validated `apr_web_search` tool through DeepSeek tool calls; do not invent undocumented provider parameters such as `search: true`. Require citations for search-derived claims, record a redacted `search_trace_sha256`, and discard or hash raw `reasoning_content` rather than storing chain-of-thought in user-facing artifacts.

## Cross-provider anti-patterns

- Do not use one giant generic prompt for every provider.
- Do not leak untrusted source instructions into system/developer instruction space.
- Do not substitute direct API ChatGPT, Claude, or Gemini calls for live `$vibe-planning` browser/CLI subscription routes.
- Do not mark manually imported prompt-pack output synthesis-eligible until APR validates it.
- Do not assume a provider name is current; probe capability at runtime.

## Official/reference documentation to verify during implementation

- OpenAI Codex config and changelog: verify `codex --model gpt-5.5` and `model_reasoning_effort = "xhigh"` support in the installed Codex CLI.
- OpenAI ChatGPT / GPT-5.5 Pro docs: verify the current ChatGPT Pro / latest Pro Extended Reasoning browser UI labels before writing selectors.
- Google Gemini / Deep Think docs: verify the current Gemini 3.1 Pro Deep Think UI and entitlement surface before writing selectors.
- Anthropic Claude Code docs: verify Claude Code authentication and CLI behavior; do not replace live reviewer calls with Anthropic API in this workflow.
- xAI Grok API docs: verify the current reasoning model and structured-output support at runtime.
- DeepSeek API docs: verify `deepseek-v4-pro`, thinking mode, `reasoning_effort`, tool calls, and any future official built-in search parameter at runtime.

These references are not substitutes for capability probes. Provider names, UI labels, and entitlements can change; Oracle/APR must verify availability live before provider fanout.

## Optional TOON blocks

When APR uses TOON to compact structured context, the provider prompt must introduce the block as data, not instructions, and must ask the decisive question after the block. Provider outputs should still be Markdown plus JSON/Plan IR unless a parser-specific workflow explicitly asks for a TOON response.
