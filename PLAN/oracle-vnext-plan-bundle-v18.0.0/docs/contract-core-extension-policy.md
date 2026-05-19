# Contract Core and Extension Policy

Bundle version: v18.0.0

## Decision

Shared JSON contracts keep `additionalProperties: true` for forward compatibility, but every subset must treat the documented required fields as the **contract core**. Unknown fields may be preserved and displayed, but they must not be used for critical gating unless all three subset bundles update their contracts and fixtures together.

## Why this is necessary

The three implementation agents may work independently. If contracts are too rigid, small harmless additions will block development. If contracts are too loose, critical invariants such as browser evidence verification, API-substitution bans, or formal-first-plan eligibility can silently drift. The v18 rule is therefore strict core, permissive extension.

## Rules

1. Required fields are mandatory and must be validated by local smoke tests.
2. Unknown fields are allowed but advisory unless promoted into the contract core.
3. Promotion into the core requires updating all three specs, schemas, fixtures, mocks, and validators.
4. Critical eligibility decisions must use only core fields.
5. Consumers must ignore unknown fields safely rather than failing unless the command is running in a strict integration-test profile.
6. No unknown field may override `api_allowed`, `mode_verified`, `verified_before_prompt_submit`, `formal_first_plan`, `eligible_for_synthesis`, or `synthesis_eligible`.

## Examples

Good extension:

```json
{
  "schema_version": "browser_evidence.v1",
  "mode_verified": true,
  "verified_before_prompt_submit": true,
  "experimental_selector_score": 0.94
}
```

Bad extension:

```json
{
  "schema_version": "browser_evidence.v1",
  "mode_verified": false,
  "verified_before_prompt_submit": false,
  "experimental_override_synthesis_eligible": true
}
```

The second example must not become synthesis-eligible because the core fields fail.
