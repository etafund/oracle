# Oracle General-Purpose Boundary and `$vibe-planning` Route Policy

Bundle version: v18.0.0

## Decision

Oracle vNext must remain a general-purpose model-access CLI. The `$vibe-planning` provider-access policy must not be interpreted as a request to remove, cripple, or deprecate Oracle's existing API routes.

## What the policy means

Inside the `$vibe-planning` planning workflow:

- ChatGPT formal first-plan and synthesis slots use Oracle browser automation against ChatGPT Pro / latest Pro Extended Reasoning.
- Gemini Deep Think uses Oracle browser automation with same-session Deep Think verification.
- Claude live planning uses Claude Code CLI/subscription routes.
- Grok/xAI uses the xAI API.

Outside the `$vibe-planning` workflow, Oracle may continue to support its existing API and browser modes as designed by the Oracle project.

## Why this matters

Oracle is reusable infrastructure. APR and `$vibe-planning` consume Oracle capabilities, but they should not force Oracle to become only an Agent Flywheel planning tool. The route restriction is a workflow policy, not a global product limitation.

## Implementation consequence

Oracle should expose enough metadata for APR to enforce workflow-specific route policy:

```json
{
  "provider": "chatgpt",
  "access_path": "oracle_browser_remote",
  "workflow_policy": "vibe_planning.v17",
  "api_substitution_allowed_for_this_slot": false
}
```

But Oracle can still support ordinary API commands for unrelated Oracle users.
