# Mock-to-Live Cutover Policy

> Bundle version: v18.0.0

Mocks are development scaffolding, not proof that the workflow works. A bundle may be locally valid while still being unusable with live browser/provider routes.

Required progression:

1. Contract validation.
2. Mock route rehearsal.
3. Remote browser smoke checks.
4. Provider replay and normalization.
5. One-provider live smoke.
6. Full balanced live dress rehearsal.

Do not ship user-facing balanced/audit workflows until `fixtures/live-cutover-checklist.json` passes and the final integration pass confirms that the three bundles agree on shared contract hashes.

Anti-patterns:

- Marking mock provider output as live evidence.
- Treating `--doctor` as a substitute for a live smoke run.
- Letting the first full live run happen in front of the user.
- Allowing a waiver to bypass ChatGPT Pro first plan, ChatGPT Pro synthesis, or Gemini Deep Think in balanced/audit.
