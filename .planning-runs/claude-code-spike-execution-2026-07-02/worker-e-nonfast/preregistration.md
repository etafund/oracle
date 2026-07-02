# Worker E Non-Fast Preregistration

Agent Mail identity: AzureCitadel
Date: 2026-07-02
Scope: Spikes 14, 15, 16, 17, 23, and 24 from `SPIKE.md`.

No live browser prompts, ChatGPT/Gemini submissions, subscription prompts, or `Answer now` clicks are allowed in this lane run. Live-only parts are blockers to document, not workarounds to bypass.

## Spike 14: Browser Selector-State Proof Without Submission

Success criteria:
- Existing browser selector code, tests, diagnostics, or fixtures show how ChatGPT Pro Extended Reasoning and Gemini Deep Think readiness could be proven before prompt submission.
- Fake DOM/controller evidence can represent ready, signed-out, unavailable, wrong-mode, changed, and `selector_state_unknown` outcomes.
- Unknown selector state remains not-ready.

Kill criteria:
- Readiness requires prompt submission, guessing from unstable UI text, clicking ChatGPT `Answer now`, or accepting unknown state as ready.
- Existing code has no pre-submit selector proof seam for one or both browser lanes.

## Spike 15: Browser Lane Drift and Pre-Submit Abort Rehearsal

Success criteria:
- Runtime has, or can be given, a concrete insertion point to re-check selector state immediately before irreversible submit.
- Fake controller cases can simulate selector drift, Cloudflare/interstitials, stale assistant snapshots, unavailable controls, and `Answer now` placeholders without submission.
- Abort reasons can be represented before prompt submission.

Kill criteria:
- Browser state is checked only during doctor/lane resolution.
- Runtime can submit after selector drift.
- Echoed/flattened/stale assistant snapshots can be misclassified as valid output.

## Spike 16: MCP Launch-Context Subscription-Auth Validation

Success criteria:
- Current MCP entrypoints and tests identify what launch context is visible before an MCP-triggered local Claude spawn.
- Non-live doctor/preflight or dry-run behavior can compare executable path, HOME, PATH, env allowlist, transport locality, and local-owner guard requirements.
- Missing live MCP-client/subscription checks are documented as explicit blockers.

Kill criteria:
- MCP lacks server-side launch facts needed to prove same-user local execution.
- MCP inherits unsafe env/settings or cannot distinguish local stdio from network/remote contexts.
- `fable-local` through MCP would need client claims or live auth guessing for v1.

## Spike 17: Artifact Privacy, Redacted Export, and Purge Policy

Success criteria:
- Current session artifact writing, rendering, redaction, MCP resources, and cleanup behavior are mapped.
- Fake sensitive streams can be reasoned against artifact kind, render defaults, local path exposure, symlink/write boundaries, redacted export, and purge scope.
- Raw Claude Code artifact kinds and default exclusion rules are explicit.

Kill criteria:
- Raw streams would be generic files without kind metadata.
- Redacted exports include raw streams by default.
- Symlink redirection can write outside session storage.
- Purge scope is ambiguous enough to delete unintended artifacts.

## Spike 23: Live Local CLI Smoke After Fake Gates Pass

Success criteria:
- Exact prerequisites for a live local CLI smoke are enumerated.
- Non-live command/test evidence establishes whether those prerequisites are currently implemented.
- Any live smoke is skipped without human opt-in and real subscription readiness.

Kill criteria:
- A live smoke would be used as a substitute for fake gates, startup verifier, stream persistence, or auth/local guards.
- Running it now would require weakening no-tool/auth/local constraints or spending subscription/API quota.

## Spike 24: Live MCP and Browser Smoke After Doctor Readiness

Success criteria:
- Exact prerequisites for MCP Fable, ChatGPT Pro, and Gemini Deep Think live smokes are enumerated.
- Non-submitting readiness surfaces and blockers are identified.
- Browser smokes remain blocked unless selector proof passes and a human opts in; ChatGPT `Answer now` remains forbidden.

Kill criteria:
- Browser readiness cannot be proven without prompt submission.
- MCP launch context lacks auth/local proof.
- Complete output capture or inline event completeness cannot be represented honestly.
