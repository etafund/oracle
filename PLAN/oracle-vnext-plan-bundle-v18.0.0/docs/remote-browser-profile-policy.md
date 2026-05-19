# Remote Browser and Shared Profile Policy

Bundle version: v18.0.0

## Decision

Oracle remote browser is the primary browser execution path for `$vibe-planning` balanced and audit runs. Local browser automation remains useful for development and fallback, but the production-oriented workflow should assume that a coding agent may need to use a remote browser endpoint already authenticated to the user's subscription accounts.

The user requested one shared profile. v18 interprets this as a **shared logical browser identity boundary**, not necessarily a single physical Chrome profile directory for every upstream provider implementation.

## Practical meaning

- There is one remote browser endpoint for the workflow.
- The endpoint represents one user-authenticated context.
- ChatGPT Pro and Gemini Deep Think browser routes acquire provider-specific locks before use.
- APR and `$vibe-planning` never directly inspect cookies, DOM, screenshots, or profile directories.
- Oracle may internally maintain provider-specific technical profiles or cookie adapters if its upstream architecture requires that, but those details stay inside Oracle.
- The contract-visible state is one logical `profile_id_hash`, one remote endpoint, and provider locks such as `browser:shared-profile:chatgpt` and `browser:shared-profile:gemini`.

## Why this nuance matters

A literal single Chrome profile directory sounds simple, but upstream browser tools often use different paths for ChatGPT web automation and Gemini web/cookie automation. Forcing the same physical profile everywhere could make Oracle less robust. The product requirement is not a particular directory layout; it is a reliable, user-authenticated browser identity with no parallel provider corruption and no secret leakage.

## Required Oracle behavior

Oracle must expose:

```bash
oracle remote doctor --json
oracle browser leases plan --providers chatgpt,gemini --remote-browser preferred --json
oracle browser leases acquire --provider chatgpt --json
oracle browser leases release --provider chatgpt --lease-id ID --json
```

Every command must return a stable JSON envelope with `blocked_reason`, `next_command`, `fix_command`, and `retry_safe`.

## Required APR behavior

APR consumes remote browser readiness and browser lease/evidence records. APR must not know DOM selectors, cookies, browser profile paths, or remote browser tokens.

## Required `$vibe-planning` behavior

`$vibe-planning` dry-runs must make the remote browser dependency visible before live calls and must never ask a coding agent to infer how to recover a missing remote browser endpoint.
