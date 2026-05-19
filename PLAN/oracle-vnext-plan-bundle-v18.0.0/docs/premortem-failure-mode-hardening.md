# v18 Premortem Failure-Mode Hardening

> Bundle version: v18.0.0

## Scenario

Assume this product failed six months after implementation. The failure was not caused by one bug; it was caused by optimistic assumptions compounding across three independently implemented packages.

The most likely collapse looked like this:

1. Browser automation appeared to work, but ChatGPT Pro / Gemini Deep Think mode verification was sometimes stale or wrong.
2. Remote browser sessions behaved like stateful shared infrastructure, not stateless API calls.
3. Mock fixtures passed, but the first live cutover exposed lease, output-capture, and schema-drift problems.
4. Highest-reasoning defaults made runs slow and expensive; users had no clear progress view.
5. Waivers and fallbacks became loopholes that hid degraded plans.
6. Evidence artifacts either over-claimed proof or risked leaking sensitive browser state.
7. Independent coding agents drifted on shared contracts.

## v18 response

v18 keeps the architecture but adds operational guardrails:

- `failure_mode_ledger.v1` records the pessimistic assumptions, symptoms, controls, and acceptance checks.
- `live_cutover_checklist.v1` forces mock-to-live rehearsal before the system is called ready.
- `fallback_waiver.v1` makes degraded runs explicit, scoped, expiring, and visible in handoff.
- `run_progress.v1` makes long runs observable to humans and agents.
- Specs now state that evidence is an attestation with confidence, not cryptographic proof of provider internals.

## What this prevents

This pass is not meant to add abstract process. It prevents the exact failures that would make users hate the product: silent wrong-mode success, unexplained waiting, mock-only demos, hidden downgrade, privacy leakage, and last-minute integration incompatibility.
