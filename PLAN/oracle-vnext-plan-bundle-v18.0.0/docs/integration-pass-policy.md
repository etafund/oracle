# Final Integration Pass Policy

> Bundle version: v18.0.0

The three package agents work independently, so a fourth integration pass is required before release. `$vibe-planning` is the runtime orchestrator; it is not the development-time authority that reconciles incompatible Oracle and APR implementations.

The integration pass must:

- compare shared contract hashes across all three packages,
- replace mocks with live commands one route at a time,
- run the live cutover checklist,
- verify redacted evidence links into APR provider results,
- verify review quorum and waiver behavior,
- produce a human review packet from a full balanced dress rehearsal.
