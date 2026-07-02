# Worker F Non-Fast Preregistration

Date: 2026-07-02
Agent Mail name: QuietEagle
Lane: Spikes 12, 20, 21, 22

This preregistration adopts the prior Worker F criteria from
`.planning-runs/claude-code-spike-execution-2026-07-02/worker-f/preregistration.md`
and freezes the non-fast replacement criteria below before running local evidence
commands.

## Spike 12: Prompt Assembly / Supplied Context

Success:
- Existing Oracle prompt/file assembly can form a useful supplied-context bundle
  for Claude Code without relying on Claude Code Read/Grep/Glob.
- File exclusions, default ignored directories, dotfile behavior, and size caps
  remain Oracle-owned and testable.
- The future subprocess contract can send prompt content over stdin and close it
  deterministically, not via argv.

Kill:
- Realistic bundles cannot represent required review context without Claude Code
  tools.
- Oracle cannot preserve exclusions or size limits before spawning Claude Code.
- The implementation requires putting prompt content in argv.

## Spike 20: Integration Seam Map

Success:
- CLI active starts, MCP consult starts, restarts, follow-ups, and shared runner
  checks have small enforceable chokepoints.
- Passive commands and passive MCP session resources can stay route-neutral.
- The plan can be split into disjoint write sets with tests around route
  blocking before side effects.

Kill:
- Lane/provider checks must be scattered through unrelated command bodies.
- Passive commands are entangled with active route resolution.
- Route blocking cannot occur before session/backend side effects.

## Spike 21: Sequencing Split

Success:
- Maintainers can name fake-run, live-local, MCP, and beta milestones with
  crisp prerequisites and independent rollback points.
- The earliest milestone provides evidence without live Claude/browser/MCP
  dependency.

Kill:
- Useful learning requires browser doctors, MCP overflow, and live Fable before
  the architecture can be tested.
- A broad preliminary refactor is required before any evidence can land.

## Spike 22: Compliance / Public Wording

Success:
- Behavior and docs can be framed as local-owner-only use of the official
  Claude Code CLI, with no hosted routing, credential collection, API
  substitution promise, or billing/quota certainty.
- Startup/result guards can reduce accidental API/gateway usage and make
  limitations visible.

Kill:
- Current official Anthropic/Claude Code sources make the intended public use
  clearly disallowed or materially ambiguous for ordinary release wording.
- Required wording implies guarantees or hidden state Oracle cannot observe.
