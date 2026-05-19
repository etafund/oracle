# Changelog entry: v18.0.0

- Added premortem failure-mode hardening.
- Added `failure_mode_ledger.v1`, `live_cutover_checklist.v1`, `fallback_waiver.v1`, and `run_progress.v1`.
- Tightened mock-to-live cutover expectations so local validation cannot be mistaken for live provider readiness.
- Added explicit policy that browser evidence is a redacted UI attestation, not cryptographic proof of hidden provider backend routing.
- Added user-experience failure controls for progress, blockers, waivers, and human review packet visibility.

# Changelog

Bundle version: v18.0.0

## v18.0.0

- Replaced placeholder `sha256:*` fixture values with full SHA-256-shaped values and added validator checks.
- Added remote browser endpoint, prompt context packet, and route readiness contracts plus fixtures.
- Added negative fixtures for forbidden Codex promotion, forbidden API substitution, and unverified browser evidence.
- Strengthened browser lease and browser evidence contracts with timestamps, profile-scope semantics, and redacted privacy expectations.
- Clarified that one shared profile means one shared logical remote browser identity boundary with provider-specific locks, not necessarily one physical Chrome profile directory.
- Made mocks less permissive and improved robot-facing unsupported-command failures.
- Added v18 audit, remote browser profile policy, and contract core/extension policy docs.

## v18 DeepSeek provider addition

Bundle version: v18.0.0

Adds `deepseek_v4_pro_reasoning_search` as a default optional independent comparison-review provider. This route uses the official DeepSeek API with `deepseek-v4-pro`, thinking enabled, `reasoning_effort=max`, and APR-provided web-search tool calls. It is an API-allowed exception like xAI/Grok; it does not weaken the ban on direct API substitution for ChatGPT, Gemini, or Claude.

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
