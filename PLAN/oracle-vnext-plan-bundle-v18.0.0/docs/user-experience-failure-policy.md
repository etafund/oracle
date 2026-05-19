# User Experience Failure Policy

> Bundle version: v18.0.0

The workflow will fail as a product if it feels like a mysterious expensive wait. Users should always know:

- what stage is running,
- whether live providers have started,
- which model/provider is blocking,
- whether a fallback is available,
- what command or action comes next,
- whether the current run is implementation-handoff eligible.

Use `run_progress.v1` and JSON envelopes with `blocked_reason`, `next_command`, `fix_command`, and `retry_safe`. Human review packets should lead with a compact summary and decisions, not a wall of provenance.
