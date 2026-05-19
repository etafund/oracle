# v18 Bundle Audit Findings

> Bundle version: v18.0.0

## Findings from the v18 audit

1. **ChatGPT browser effort was over-specified as `Heavy`.** v18 changes the contract to `max_browser_available` plus observed-label evidence.
2. **Gemini Deep Think effort semantics were mixed with browser-mode naming.** v18 separates `browser_mode=Deep Think` from `requested_reasoning_effort=deep_think_highest_available` and records `thinking_level_if_exposed=high` separately.
3. **Route readiness mixed preflight readiness with synthesis eligibility.** v18 introduces stage-scoped readiness fields.
4. **Provider documentation freshness was implicit.** v18 adds `provider_docs_snapshot.v1` and an explicit freshness policy.
5. **Claude Code effort needed more precise semantics.** v18 keeps `--effort max` as the real control and treats `ultrathink` as an additional one-off in-context request, not a substitute for the effort setting.
6. **Validation needed to catch browser-effort hard-coding regressions.** v18 validators fail if ChatGPT browser routes require literal `Heavy` instead of `max_browser_available`/highest-visible selection.

## Outcome

The v18 bundles are stricter about highest-reasoning defaults while being less brittle about browser UI labels.
