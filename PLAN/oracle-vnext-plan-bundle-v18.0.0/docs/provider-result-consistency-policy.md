# Provider Result Consistency Policy

> Bundle version: v18.0.0

Provider results, browser evidence, prompt manifests, source baselines, and artifact indexes must agree on IDs and hashes. APR may accept permissive extension fields, but eligibility decisions must be based only on core fields.

## Required consistency checks

- `provider_result.provider_result_id` must match the browser evidence `provider_result_id` for browser routes.
- `provider_result.evidence_id` must match the evidence object for critical browser routes.
- Browser evidence must verify mode and effort before prompt submission.
- Optional API reviewers need no browser evidence, but must provide provider-family-specific reasoning-effort verification.
- DeepSeek and xAI provider results must be present in fixtures because both are default optional reviewers.
