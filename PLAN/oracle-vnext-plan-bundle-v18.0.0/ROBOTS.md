# ROBOTS.md — oracle

> Bundle version: v18.0.0

This file is for coding agents. Use the first command that matches your intent; do not guess undocumented flags.

## First commands

- `oracle capabilities --json`
- `oracle doctor --json`
- `oracle browser leases plan --providers chatgpt,gemini --json`
- `python3 scripts/oracle-mock.py --json`
- `python3 scripts/validate-subset.py --json`

## JSON contract

Every robot-facing command must support `--json` and return a JSON envelope with `ok`, `schema_version`, `data`, `meta`, `warnings`, `errors`, and `commands`. Failures must also include `blocked_reason`, `next_command`, `fix_command`, and `retry_safe`.

## Anti-patterns

- Do not call live providers in doctor/capabilities commands.
- Do not parse human prose when a JSON mode exists.
- Do not hide fallback or degradation.
- Do not print secrets.

## Recovery

When blocked, follow `next_command` first. Use `fix_command` to verify recovery. If `retry_safe` is false, do not retry automatically.

## v18 Agent-Ergonomics Addendum

Bundle version: v18.0.0

The required error fields (`blocked_reason`, `next_command`, `fix_command`, `retry_safe`) come from the attached agent CLI ergonomics skill. They are required for both implementation-time coding agents and runtime orchestration agents.

Good pattern:

```json
{
  "ok": false,
  "blocked_reason": "remote_browser_token_missing",
  "next_command": "export ORACLE_REMOTE_TOKEN=...",
  "fix_command": "oracle remote doctor --json",
  "retry_safe": true
}
```

Bad pattern:

```text
Error: browser failed
```

Never make an agent guess whether a failure is safe to retry, what command should run next, or which environment variable is missing.

## v18.0.0 robot additions

- Use `python3 scripts/validate-subset.py --json` as the local self-check.
- Use mock commands listed in `robots.json[*].mock_command` when the real package command is not implemented yet.
- Treat `blocked_reason`, `next_command`, `fix_command`, `retry_safe`, `required_env`, and `docs_url_or_path` as development-time and runtime recovery fields.
- Do not infer that a browser call is usable unless the remote browser endpoint, browser lease, and redacted evidence contracts all pass local validation.

## v18 DeepSeek provider addition

Bundle version: v18.0.0

Adds `deepseek_v4_pro_reasoning_search` as a default optional independent comparison-review provider. This route uses the official DeepSeek API with `deepseek-v4-pro`, thinking enabled, `reasoning_effort=max`, and APR-provided web-search tool calls. It is an API-allowed exception like xAI/Grok; it does not weaken the ban on direct API substitution for ChatGPT, Gemini, or Claude.

## v18 highest-reasoning invariant

Every live model call in this workflow must request the highest provider-specific reasoning effort available. See `docs/highest-reasoning-policy.md` and `fixtures/model-reasoning-policy.json`. Missing, unknown, default, or downgraded effort is not synthesis-eligible for `balanced` or `audit` unless a waiver is recorded before the call.

## v18.0.0 review corrections

- Browser effort labels are not stable contracts. ChatGPT Pro browser routes now request `max_browser_available` and require Oracle evidence that the highest visible effort was selected before prompt submission.
- Gemini Deep Think browser routes now distinguish `browser_mode=Deep Think` from `requested_reasoning_effort=deep_think_highest_available`; if a separate thinking-level control is exposed, select `high`.
- Route readiness is stage-scoped: preflight readiness does not imply synthesis eligibility.
- Provider docs are captured in `fixtures/provider-docs-snapshot.json` and must be refreshed before audit runs or implementation if provider surfaces changed.
- Claude Code Opus uses `--effort max`/`CLAUDE_CODE_EFFORT_LEVEL=max`; `ultrathink` is an additional one-off request, not a replacement for effort configuration.

## v18 semantic audit updates

- Adds `review_quorum.v1` so balanced planning requires Gemini Deep Think plus at least one additional independent reviewer before synthesis, unless the user records an explicit waiver.
- Splits synthesis gating into `synthesis_prompt_blocked_until_evidence_for` and `final_handoff_blocked_until_evidence_for`, avoiding the circular mistake of requiring ChatGPT synthesis evidence before the synthesis call can run.
- Adds `provider-result.xai.json` so every default optional reviewer has a provider-result fixture.
- Tightens DeepSeek reasoning-content handling: raw `reasoning_content` may be retained only transiently for required tool-call replay and may be persisted only as hashes.
- Adds provider-doc snapshot expiration fields so live provider assumptions are refreshed before real provider calls.

## v18 premortem hardening

Bundle version: v18.0.0

v18 adds a pessimistic failure-mode ledger, a live cutover checklist, explicit fallback waiver semantics, and run-progress artifacts. These are included because the most likely failure mode is not a syntax error; it is a plausible mock/demo run that hides browser mode drift, live-provider flakiness, silent downgrade, or user-visible waiting.

Read:

- `docs/premortem-failure-mode-hardening.md`
- `docs/mock-to-live-cutover-policy.md`
- `docs/degradation-waiver-policy.md`
- `docs/user-experience-failure-policy.md`
- `fixtures/failure-mode-ledger.json`
- `fixtures/live-cutover-checklist.json`

## v18 TOON context-compression commands

- TOON is gated optional and used only for prompt-context compression after user/legal approval. Canonical artifacts remain JSON/Markdown.
- If `toon`/`tru` is unavailable or the license gate is not approved, continue with JSON and surface `toon_unavailable_json_fallback`.
- Oracle should pass prompt files through unchanged and should not own TOON encoding policy.
