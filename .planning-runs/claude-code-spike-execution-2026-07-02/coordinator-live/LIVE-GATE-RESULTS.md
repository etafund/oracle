# Approved Live Gate Results

Date: 2026-07-02
Coordinator: RubyCliff

## Human Decisions Captured

- Claude live probes: approved and run.
- Browser readiness: approved for live ChatGPT Pro browser automation only.
- Browser prompt smokes: approved for ChatGPT Pro. Gemini Deep Think was intentionally skipped because there is no active Gemini lane/subscription.
- MCP: CLI-only for `fable-local`; do not implement or advertise MCP `fable-local` in the hidden alpha.
- Sequencing: hidden alpha is acceptable.
- MCP overflow policy: deferred.
- Raw purge scope: deferred.

## Claude Code Live Probe

Preflight:

- Blocked provider/env variable name scan: no matches.
- `claude --version`: `2.1.198 (Claude Code)`.
- `claude auth status --json`, redacted fields: `loggedIn: true`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`, `subscriptionType: "max"`.

Invalid empty MCP config probe:

- `--mcp-config '{}'` failed before a model call.
- Error: `mcpServers: Invalid input: expected record, received undefined`.
- Plan change: use `--mcp-config '{"mcpServers":{}}'` for an empty strict MCP config.

Normal live stream probe:

- Command shape: `claude -p --model fable --effort xhigh --output-format stream-json --verbose --include-partial-messages --include-hook-events --permission-mode plan --safe-mode --disable-slash-commands --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disallowedTools 'mcp__*' --no-chrome --no-session-persistence --tools ''`.
- Exit code: `0`.
- Duration: about 11 seconds.
- Expected final token: `ORACLE_SPIKE_CLAUDE_OK_20260702`.
- Final token observed exactly.
- Startup fields observed:
  - `tools: []`
  - `mcp_servers: []`
  - `model: "claude-fable-5"`
  - `permissionMode: "plan"`
  - `slash_commands: []`
  - `apiKeySource: "none"`
  - `claude_code_version: "2.1.198"`
  - `agents: ["claude", "Explore", "general-purpose", "Plan"]`
  - `skills: []`
  - `plugins: []`
  - `fast_mode_state: "off"`
- Rate-limit event observed:
  - `status: "allowed"`
  - `rateLimitType: "five_hour"`
  - `overageStatus: "rejected"`
  - `isUsingOverage: false`
- Result fields observed:
  - `subtype: "success"`
  - `result: "ORACLE_SPIKE_CLAUDE_OK_20260702"`
  - `stop_reason: "end_turn"`
  - `terminal_reason: "completed"`
  - `total_cost_usd` present.
  - `usage` present.
  - `modelUsage` present.

Important verifier nuance:

- `modelUsage` included `claude-fable-5`, but also a small `claude-haiku-4-5-20251001` entry. The startup and assistant message model were Fable. A v1 verifier should distinguish primary assistant model usage from auxiliary Claude Code bookkeeping usage instead of failing on any non-Fable key in `modelUsage`.
- Built-in `agents` remained listed even with `--safe-mode`, `--disable-slash-commands`, and `--tools ""`. No agent/tool invocation occurred in the probe, but startup verification cannot require `agents: []` unless a stronger flag is found.

## `ANTHROPIC_MODEL` Precedence Probe

Environment for this probe:

- Parent command set `ANTHROPIC_MODEL=claude-haiku-4-5-20251001`.
- CLI still passed `--model fable`.

Result:

- Exit code: `0`.
- Duration: about 10 seconds.
- Expected final token: `ORACLE_SPIKE_MODEL_PRECEDENCE_OK_20260702`.
- Final token observed exactly.
- Startup `model` remained `claude-fable-5`.
- Assistant message model remained `claude-fable-5`.
- Result `modelUsage` again included primary Fable usage plus a small Haiku entry.

Decision impact:

- On Claude Code `2.1.198`, `--model fable` wins over `ANTHROPIC_MODEL` for the main assistant run.
- Product code can either keep the conservative hard refusal for `ANTHROPIC_MODEL` or scrub it from the child environment after recording a warning. It should still hard-refuse API keys, base URLs, provider/gateway toggles, auth helper settings, and BYOK/provider credentials before spawn.

## ChatGPT Pro Browser Live Probe

Doctor/readiness:

- `oracle doctor chatgpt --pro --extended-reasoning --json` remained `degraded`.
- Reasons: no default live UI probe, local keytar missing, recent ChatGPT session reachable.
- `oracle remote doctor --json` was healthy through the configured remote browser router at `127.0.0.1:9470`.

Vitest live smoke:

- Command: `ORACLE_LIVE_TEST=1 ORACLE_LIVE_BROWSER=1 ORACLE_LIVE_ARTIFACT_DIR=.planning-runs/claude-code-spike-execution-2026-07-02/coordinator-live/browser-smoke pnpm vitest run tests/live/chatgpt-smoke-live.test.ts --reporter=verbose`.
- Result: test process passed, but the test skipped the run because its preflight only checked local Chrome cookies unless `ORACLE_LIVE_REMOTE_CHROME` is set.
- Structured skip log: `.planning-runs/claude-code-spike-execution-2026-07-02/coordinator-live/browser-smoke/chatgpt/live-chatgpt-pro-1782980288127.jsonl`.

Direct remote-browser CLI smoke:

- Command shape: `oracle --remote-browser required --engine browser --provider chatgpt --model gpt-5.5-pro --browser-thinking-time extended --prompt <redacted> --slug chatgpt-pro-live-spike --wait --verbose --force`.
- Session: `chatgpt-pro-live-spike`.
- Reattach command: `oracle session chatgpt-pro-live-spike`.
- Remote routing: `127.0.0.1:9470`.
- Model selection evidence:
  - `requested=Pro`
  - `resolved=Pro Extended`
  - `status=already-selected`
  - `strategy=select`
  - `verified=yes`
- Output token expected: `CHECK_CHATGPT_PRO_OK_20260702`.
- Output token observed exactly.
- Duration: about 17.5 seconds.
- Output file: `.planning-runs/claude-code-spike-execution-2026-07-02/coordinator-live/chatgpt-pro-output.txt`.
- Conversation was archived after local artifacts were saved.

Decision impact:

- The remote ChatGPT Pro browser lane is live enough for an exact-token smoke through the current router.
- The provider doctor remains weaker than the runtime path because it does not do a default non-submitting live UI probe.
- The Vitest live smoke should either support the `oracle serve` remote-browser route in its preflight or document that it only supports local Chrome / remote DevTools.

## Still Deferred

- Gemini Deep Think: skipped by operator decision; no active lane/subscription.
- MCP `fable-local`: CLI-only hidden alpha; no MCP implementation or smoke.
- MCP overflow policy: still needs a product decision after more context.
- Raw purge scope: still needs a product decision after more context.
