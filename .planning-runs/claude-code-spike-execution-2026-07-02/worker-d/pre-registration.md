# Worker D Pre-Registration

Date: 2026-07-02
Agent: RusticCliff
Scope: Spikes 7, 8, and 11 only.

## Spike 7: Local-owner and transport eligibility proof

Success criteria:
- Every active Claude Code spawn path identified in Oracle has a proposed local-only decision before process start.
- Ambiguous MCP/server/router/network contexts are refused in the proposed guard matrix.
- Ordinary same-user macOS/Linux CLI and stdio-local execution remain allowed when ownership checks pass.
- Refusal reasons are machine-readable and usable before session creation, worker dispatch, router request, or subprocess spawn.

Kill criteria:
- MCP transport locality or same-user ownership cannot be proven from server-side launch facts.
- Remote/server/router contexts can reach a local Claude spawn before refusal.
- The proposed guard would rely on client-supplied claims instead of process, transport, filesystem, or launch metadata.

## Spike 8: Executable provenance and launch-context trust

Success criteria:
- Common legitimate install shapes can be represented without executing binaries.
- Repo-local, relative, unsafe symlink, world-writable component, and shell-wrapper-danger cases are denied.
- The proposed child spawn contract uses an absolute resolved executable with `shell: false`, and prompt content never appears in argv.
- Doctor diagnostics can explain what was resolved, what was refused, and how to remediate.

Kill criteria:
- Valid and malicious shims are indistinguishable with available stat/realpath metadata.
- PATH resolution cannot be made safe enough for v1.
- The evidence indicates the product should require explicit trusted executable configuration instead of PATH resolution.

## Spike 11: Lifecycle, process-tree, timeout, and lock failure drill

Success criteria:
- A safe fake-run harness can exercise child/grandchild termination, timeout, SIGINT-style cancellation, nonzero exit, partial line capture, flood abort, and lock contention.
- The proposed single-flight lock scope allows at most one `fable-local` child live per owner/session scope.
- Terminal paths preserve partial artifacts when possible, report event completeness honestly, and release or recover locks.
- Process-tree cleanup notes identify Linux behavior and blocked macOS/Windows checks separately.

Kill criteria:
- Children or descendants can continue running after Oracle reports terminal failure in the proposed attached-only model.
- Stale locks require unaudited manual deletion.
- Detached/background behavior is required to make cleanup work.
