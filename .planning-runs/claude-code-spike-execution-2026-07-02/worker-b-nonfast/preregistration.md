# Worker B Non-Fast Preregistration

Date: 2026-07-02
Agent Mail identity: MagentaTiger
Scope: `SPIKE.md` Spikes 2, 13, 18, and 19. Planning/spike evidence only; no product implementation.

## Spike 2: Central Lane Start Gate

Success criteria:
- A central resolver or a very small set of explicit wrappers can classify active CLI and MCP starts before backend side effects.
- Unsupported active requests return `agent_lane_blocked`, exit code `2`, replacement commands for all three reviewed lanes, and `noBackendStarted: true`.
- Passive status/render/session/capabilities commands can remain outside active lane resolution.

Kill criteria:
- Active starts are too scattered to prove no backend started.
- Config/env/prior-session defaults can infer active routes without a reviewed lane after the proposed insertion point.
- Policy must be duplicated independently in providers or backend clients.

## Spike 13: Provider Boundary and Model Alias Invariants

Success criteria:
- `fable` and `claude_code_fable_5` are scoped only to `claude-code` / `fable-local` style local subscription routes.
- API and `--models` fan-out requests using Fable aliases block before provider selection.
- `claude_code_fable_5` requires `claude_code_subscription_cli` and rejects `anthropic_api`.

Kill criteria:
- Shared model/provider registries cannot prevent Fable aliases from reaching Anthropic API, OpenRouter, Azure, or existing Claude API clients.
- Multi-model fan-out can start local Claude Code.
- MCP engine/model compatibility forms can bypass the lane policy boundary.

## Spike 18: Route-Block Self-Correction

Success criteria:
- Every rejected active route includes attempted route, block reason, policy version, source precedence, supported lane templates, exit code `2`, and `noBackendStarted: true`.
- JSON and human stderr outputs are sufficient for a calling agent to retry once without reading docs.
- Prompt text and secrets are absent from block output.

Kill criteria:
- Errors only say "see help" or provide non-executable placeholders.
- JSON lacks enough structure for MCP callers.
- Error output leaks prompt text or secret values.

## Spike 19: Single-Source Lane UX

Success criteria:
- Help lane section, `oracle capabilities --json`, MCP lane enum, route-block replacements, doctor lane records, and lane policy cases can be generated from one lane registry shape.
- Adding/removing a lane changes all sample surfaces through one data definition.
- Snapshot tests would detect drift.

Kill criteria:
- Lane names, replacement commands, readiness metadata, or schema enums must be maintained separately across CLI, MCP, docs, and tests.
- Capabilities/help/route-block replacements can disagree.
