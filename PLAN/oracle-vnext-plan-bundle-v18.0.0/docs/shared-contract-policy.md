# Shared Contract Policy

> Bundle version: v18.0.0

Each v18 subset carries local copies of the shared contracts because separate coding agents will implement the packages without access to each other. This duplication is deliberate.

## Rule

A shared contract change is incomplete until all three bundles' contract copies, fixtures, robot docs, and specs are updated.

## Current critical shared contracts

- `json-envelope.schema.json`
- `provider-access-policy.schema.json`
- `browser-lease.schema.json`
- `browser-evidence.schema.json`
- `provider-result.schema.json`
- `provider-route.schema.json`
- `codex-intake.schema.json`
- `interactive-intake.schema.json`
- `prompt-manifest.schema.json`
- `prompt-policy.schema.json`
- `plan-artifact.schema.json`
- `traceability.schema.json`

## Required process

1. Update the schema in all three bundles.
2. Update all affected fixtures in all three bundles.
3. Run `python3 scripts/contract-fixture-smoke.py --json` in all three bundles.
4. Run `python3 scripts/validate-subset.py --json` in all three bundles.
5. During final integration, compare contract hashes across the three repos or move them into a versioned shared package.

## Why this matters

The implementation agents will work independently. If Oracle, APR, and `$vibe-planning` drift on contract shape, the failure will appear late as confusing runtime incompatibility. Local duplicated contracts plus smoke tests let each agent implement alone while still targeting the same integration surface.
