# Worker F Preregistration

Agent Mail identity: LilacSpring
Date: 2026-07-02
Scope: Spikes 12, 20, 21, and 22 from `SPIKE.md`.

## Spike 12: Prompt Assembly and Supplied-Context Workload Fit

Success criteria:
- Existing prompt assembly can produce useful review context without granting Claude Code `Read`, `Grep`, or `Glob`.
- File exclusions and size checks remain owned by Oracle before stdin handoff.
- The candidate Claude Code runner can pass prompt content on stdin and terminate stdin deterministically.

Kill criteria:
- Real review bundles cannot fit or be represented without Claude Code file tools.
- Secret exclusions cannot be preserved.
- Prompt content must be passed through argv or raw user-supplied Claude pass-through args are possible.

Evidence to collect:
- Prompt assembly entrypoints, option schema, file/glob handling, exclusion and secret behavior, stdin/argv subprocess seams, and targeted tests or harnesses where practical.

## Spike 20: Existing Oracle Integration Seam Map

Success criteria:
- A small number of enforceable chokepoints exist for CLI and MCP active runs.
- Passive commands can be kept outside lane resolution.
- Lifecycle refusals can share route-block/error helpers instead of duplicating policy in providers.

Kill criteria:
- Provider/runner-specific ad hoc checks are required everywhere.
- Passive commands are entangled with active route resolution.
- Route-block cannot happen before session worker, provider, browser, router, or subprocess side effects.

Evidence to collect:
- File-by-file active/passive entrypoint map across CLI options, session runner/store, MCP consult/resources, provider boundaries, API substitution guard, and tests.

## Spike 21: Sequencing Split

Success criteria:
- Maintainers can name fake-run, opt-in live local, MCP, and agent-facing beta milestones with crisp prerequisites.
- The first implementation PRs can be cut along disjoint write sets.

Kill criteria:
- Every useful sequence requires completing browser doctors, MCP overflow semantics, and live Fable integration first.
- A preliminary architecture refactor is required before any learning milestone.

Evidence to collect:
- Touched-file estimates and risk comparison for adapter-first, gate-first, and shared-skeleton sequencing.

## Spike 22: Compliance and Public Wording Check

Success criteria:
- Proposed behavior and wording stay local-owner-only, non-hosted, not credential-collecting, not an API substitute, and non-misleading about billing or quota certainty.

Kill criteria:
- Current official Anthropic/Claude Code docs, support guidance, or terms make the intended use ambiguous or disallowed.
- Public wording implies billing guarantees or hidden state Oracle cannot observe.

Evidence to collect:
- Current official Anthropic/Claude Code documentation and support URLs with access date, plus a dated wording memo.
