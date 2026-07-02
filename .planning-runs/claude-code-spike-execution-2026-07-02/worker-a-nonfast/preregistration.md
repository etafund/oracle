# Worker A Non-Fast Preregistration

Date: 2026-07-02
Agent: CalmTower
Lane: Spikes 1, 3, 4, and 9

## Scope Limits

- Planning/spike evidence only.
- No product implementation.
- No live Claude subscription prompts.
- No ChatGPT/Gemini browser submissions.
- Allowed local Claude Code inspection: `claude --version`, `claude --help`, `claude -p --help`, path/env inspection, and non-prompt static analysis.
- Blocked live-only probes: any `claude -p` run that sends a prompt or could spend subscription/API quota.

## Spike 1 Criteria

Success:

- Installed `claude`, if present, exposes version and help without prompt submission.
- Help output confirms or denies support for required headless/stream flags.
- Parent environment can be checked for API/provider variables before any prompt.

Kill or block:

- `claude` is unavailable.
- Help/version inspection requires auth or prompt submission.
- Required fields for auth source, resolved model, tools, or billing can only be verified by live prompt output; mark live-only instead of guessing.

## Spike 3 Criteria

Success:

- Help output supports a no-tool/no-config candidate argv, or clearly identifies missing flags.
- Static evidence names every containment surface as emit, verify, refuse, or live-only.

Kill or block:

- `--tools ""` or equivalent cannot be supported by the installed CLI.
- Critical config surfaces have no visible flag and no startup verifier field from non-live evidence.

## Spike 4 Criteria

Success:

- A parent-refusal matrix can be generated before executable resolution.
- Refused variables include names only and never values.
- Child env allowlist can be specified from existing plan constraints.

Kill or block:

- Any known API/provider auth source would need to reach Claude Code before detection.
- `ANTHROPIC_MODEL` precedence cannot be proven non-live; default to refusal or live-only decision.

## Spike 9 Criteria

Success:

- A fail-closed startup/result verifier decision table can be drafted from required fields and synthetic fixtures.
- Missing critical fields, unknown schema, non-Fable model evidence, non-empty tools, active MCP/config surfaces, and API auth all produce non-success reason codes.

Kill or block:

- Verifier would need to infer safe state from absent fields.
- Requested-only model evidence would be accepted as verified Fable.

## Planned Commands

- `command -v claude`
- Environment name scan for blocked Anthropic/Claude provider variables, values redacted.
- `claude --version`
- `claude --help 2>&1`
- `claude -p --help 2>&1`
- Repository/static inspection commands using `rg`, `sed`, and `find`.
