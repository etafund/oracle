# TOON Rust Context-Format Policy

> Bundle version: v18.0.0

## Decision

`toon_rust` should be incorporated, but only as an **optional model-facing structured context compression layer**. It must not replace JSON as the canonical contract, evidence, run-state, provider-result, manifest, or validation format.

The right boundary is:

- `$vibe-planning` exposes `--context-format json|toon|auto`, records the selected policy, and includes the setting in dry-run/robot plans.
- APR owns prompt compilation and decides whether a structured context packet should be rendered to TOON before being embedded in a provider prompt.
- Oracle treats TOON sections as opaque prompt text supplied by APR. Oracle must still emit JSON envelopes, JSON evidence, JSON capability results, and JSON provider results.

## Why this helps

The plan stack passes large structured artifacts to frontier models: source summaries, provider routes, route readiness, review quorum, runtime budget, model reasoning policy, and compact source-trust summaries. These artifacts are JSON-shaped but are often read by an LLM rather than parsed by a program at inference time. TOON can reduce prompt tokens for that model-facing payload while preserving deterministic round-trip structure.

`toon_rust` is a reasonable candidate because the repo describes it as a spec-first Rust port of TOON with deterministic output, strict validation, streaming decode, and token-efficiency options. The integration guide also recommends a format selector pattern so tools can emit JSON or TOON without reworking the tool.

## Important repo caveat

The current repository has a binary-name ambiguity across docs: README examples use `toon`, while the integration guide refers to `tru`. Therefore implementation must **probe binary candidates** in this order: `toon`, then `tru`, then a configured explicit path. Do not hard-code one name.

## Usage patterns

Good uses:

- Model-facing compact summaries embedded in provider prompts.
- Prompt context packets after source-trust filtering and prompt-injection boundaries are already applied.
- Route readiness and reviewer-quorum summaries sent to synthesis models.
- Human review packet appendices where JSON source is also present.
- Token-budget experiments where `--context-format auto` chooses TOON only after round-trip validation and estimated savings exceed the configured threshold.

Bad uses:

- Canonical contracts or fixtures.
- Browser evidence ledgers.
- Provider-result envelopes.
- Plan IR, traceability, approvals, bundle manifests, or audit artifacts.
- Raw private prompt text, cookies, screenshots, DOM dumps, or model outputs.
- Any live provider prompt unless the prompt explicitly labels the TOON section and tells the model how to read it.

## Validation rules

1. Canonical source remains JSON.
2. TOON output must be decoded back to JSON and canonicalized before use.
3. The decoded canonical hash must match the original canonical JSON hash.
4. If validation fails, `balanced` falls back to JSON and emits a warning; `audit` blocks unless a policy explicitly allows JSON fallback.
5. `--json` CLI output always remains JSON. `--context-format toon` affects model-facing prompt payload sections only.
6. Token savings should be measured per artifact type. Default `auto` uses TOON only if estimated savings are at least 15%.

## User-facing value

This makes long multi-provider review prompts cheaper, smaller, and easier to fit into model contexts without sacrificing the JSON contracts that make the system testable. It also creates a clean experiment knob: users can compare JSON and TOON prompts without changing run state or evidence semantics.

## Package-specific responsibility

Oracle does not parse TOON. If APR supplies a prompt file containing TOON sections, Oracle sends that text to the browser provider like any other prompt text and still emits JSON evidence/results.
