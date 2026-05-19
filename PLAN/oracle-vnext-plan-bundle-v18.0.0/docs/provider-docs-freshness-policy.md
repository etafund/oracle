# Provider Documentation Freshness Policy

> Bundle version: v18.0.0

Provider model names, browser UI labels, and reasoning-effort controls can change. The v18 bundles include `fixtures/provider-docs-snapshot.json` as a dated planning snapshot, not a permanent source of truth.

## Required implementation behavior

- Re-check provider capabilities at runtime before paid/live calls.
- Treat static model names and UI labels as aliases that must be resolved or verified.
- For browser providers, trust same-session Oracle evidence over static docs.
- For CLI/API providers, capture capability probes and exact request settings in provider results.
- Before an audit run, regenerate the provider docs snapshot and rerun validators.

## Why this helps

This prevents stale plan-bundle assumptions from becoming silent runtime downgrades. It also gives isolated coding agents a concrete document to update when provider docs change.
