# Route Readiness and Stage Gates

> Bundle version: v18.0.0

## Problem fixed in v16

The v18 `route-readiness.balanced.json` said `ready=true` while also listing `blocked_on_missing_effort_verification_for`. That was logically confusing: preflight readiness happens before live browser evidence exists, while synthesis eligibility happens after provider execution.

## v18 rule

Readiness is stage-scoped.

- `preflight_ready=true` means the run can start provider execution.
- `pending_browser_evidence_for` lists browser slots that must produce evidence during execution.
- `synthesis_ready=false` before live provider results are normalized.
- `synthesis_blocked_until_evidence_for` lists slots that cannot contribute to synthesis until evidence is verified.

APR must not treat preflight readiness as synthesis eligibility.

## Stage order

1. `intake`
2. `first_plan`
3. `independent_review`
4. `compare`
5. `synthesis`
6. `human_review`
7. `handoff`

`chatgpt_pro_first_plan` is required for `first_plan`; `gemini_deep_think` is required for `independent_review` in balanced/audit; `chatgpt_pro_synthesis` is required for `synthesis`.

## v18 correction: synthesis prompt gate versus final handoff gate

Use `synthesis_prompt_blocked_until_evidence_for` for evidence that must exist before APR submits ChatGPT Pro synthesis. Use `final_handoff_blocked_until_evidence_for` for evidence that must exist before APR hands the final plan to `$planning-workflow`. Do not require `chatgpt_pro_synthesis` evidence before running the synthesis call itself.
