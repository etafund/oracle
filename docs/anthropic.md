# Anthropic (Claude) Integration Plan

Status: **shipped** (November 20, 2025)  
Scope: API support for Claude 4.5 Sonnet and Claude 4.1 Opus in Oracle CLI.

## Models & Pricing (public list prices)

- **claude-sonnet-4-6** (CLI alias: `claude-4.6-sonnet`) — 200k context, ~$3 / 1M input tokens, ~$15 / 1M output tokens.
- **claude-opus-4-1** (CLI alias: `claude-4.1-opus`) — 200k context, ~$15 / 1M input tokens, ~$75 / 1M output tokens.
- Prompt-caching premium (not modeled in CLI costs): cached input portion >200k is billed higher (Sonnet ~$6 / 1M; Opus ~$18.75 / 1M).

## Requirements

- Environment: `ANTHROPIC_API_KEY` (required), `ANTHROPIC_BASE_URL` (optional; defaults to `https://api.anthropic.com`).
- Engine: **API only**. Browser mode is blocked for Claude.
- Tokenizer: `@anthropic-ai/tokenizer` (wrapped to accept Oracle’s array inputs). Estimates are approximate; rely on API `usage` for actual billing.

## Local Claude Code lane is separate

The experimental `fable-local` lane is not part of the Anthropic API integration described above. It is a local-owner review path that runs the user's installed Claude Code CLI on the same machine, uses Oracle-supplied prompt/file context, and keeps Claude Code tools disabled for read-only review.

Key differences:

- Anthropic API mode requires `ANTHROPIC_API_KEY`; local Claude Code mode refuses when that environment variable name is present.
- Anthropic API mode calls provider API endpoints; local Claude Code mode runs the local `claude` command and must not be exposed through `oracle serve`, router/bridge flows, remote browser workers, or network MCP transports.
- Local Claude Code mode captures visible CLI events only. It does not capture hidden reasoning.
- Raw visible stream artifacts can contain prompts, file snippets, local paths, stderr, and other sensitive visible data. They are not redacted exports by default.
- MCP `consult` recognizes `lane:"fable-local"` and `engine:"claude-code"` only to return a typed hidden-alpha route-block until the MCP local-owner and full visible-event return contracts are implemented.

## Planned CLI Behavior

- Add models to `--model/--models`: `claude-4.6-sonnet`, `claude-4.1-opus`. Aliases: “sonnet”, “opus” map to those IDs.
- Background runs: **disabled** for Claude (`supportsBackground=false`). Even if `--background` is set, the run streams normally and logs a note.
- Search / tools: `web_search_preview` is ignored for Claude; `--search` is effectively off with a warning.
- Base URL: `--base-url` / `apiBaseUrl` applies per provider; falls back to `ANTHROPIC_BASE_URL` for Claude, `OPENAI_BASE_URL` for GPT.
- Cost display: uses the prices above; prompt-caching billing is not modeled (estimates are upper/lower bounds only).

## Usage Examples

- Single model (Sonnet):
  ```bash
  oracle --engine api --model claude-4.6-sonnet --prompt "Summarize the design doc" --file docs/design.md
  ```
- High-reasoning (Opus) with files report:
  ```bash
  oracle -m claude-4.1-opus --files-report --prompt "Analyze risk register" --file docs/risk.md
  ```
- Multi-model compare (GPT + Claude):
  ```bash
  oracle --models gpt-5.1-pro,claude-4.6-sonnet --prompt "Propose mitigation steps" --file docs/plan.md
  ```
  Background stays off for Claude; GPT may still use background.

## Implementation Notes (for maintainers)

- Types/config: Claude entries use `apiModel` mapping to Anthropic IDs (`claude-sonnet-4-6`, `claude-opus-4-1`); Opus stays in `ProModelName`; pricing + 200k inputLimit; Anthropic tokenizer wrapper; `supportsBackground=false`. Opus gets `reasoning: high`.
- Client factory: branch on `claude*` to the Anthropic adapter (messages.stream/create); pass provider-specific `baseUrl`.
- Env selection: `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`; log masked key per provider.
- Token estimates: wrapper flattens Oracle message arrays into text before calling `countTokens`.
- Multi-model: shared `runOptions.background` is gated by per-model `supportsBackground`; Claude never enters the background polling path.
- Docs to update alongside code: this file, `README.md` model list, `docs/configuration.md`, `docs/multimodel.md`.

## Limitations / Caveats

- Token estimates for Claude are approximate; API may still reject >200k inputs even if estimate passes.
- Prompt-caching cost deltas are not reflected in CLI estimates.
- No tool use/search for Claude in v1.

## Troubleshooting

- Missing key: “Missing ANTHROPIC_API_KEY…” — set the env var or pass `--api-key`.
- Background ignored: expected; Claude does not support the Responses-style job API.
- Search ignored: expected; Claude adapter currently drops `web_search_preview`.

## Next Steps (post-v1)

- Optional: add tool/use support with a provider-agnostic tool layer.
- Add dated model-id mapping if Anthropic starts versioned IDs (similar to Gemini resolver) — currently aliases map to the undated IDs above.
- Improve cost estimation if API exposes cached-token counters.
