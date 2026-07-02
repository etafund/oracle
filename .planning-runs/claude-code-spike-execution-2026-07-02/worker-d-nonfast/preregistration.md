# Worker D Preregistration

Date: 2026-07-02
Agent: RedCondor
Lane: Spikes 7, 8, and 11 only
Scope: planning/spike evidence. No product implementation.

## Spike 7: Local-Owner And Transport Eligibility

Success criteria:
- Every active `fable-local` spawn path can make a local-only decision before session creation, worker dispatch, router request, or subprocess spawn.
- CLI foreground and same-user local stdio MCP can pass under ordinary Linux/macOS owner conditions.
- Remote, hosted, router, serve, bridge, remote browser, remote Chrome, network MCP, ambiguous socket, and detached/session-worker contexts refuse before any `claude` executable resolution.

Kill criteria:
- MCP/locality or same-user ownership cannot be proven from server-side facts.
- Any remote/server/router context can reach local Claude Code spawn.
- The design relies on caller claims rather than server-side process, transport, and filesystem facts.

## Spike 8: Executable Provenance And Launch Context

Success criteria:
- Resolver policy records raw path, realpath, symlink chain, owner/mode, trust decision, and denial reason.
- Common install shapes are distinguishable from repo-local shadows, relative paths, unsafe symlinks, world-writable components, and dangerous shell wrappers.
- Child spawn policy is absolute executable, `shell: false`, prompt on stdin only, and no prompt bytes on argv.

Kill criteria:
- Valid and malicious shims are indistinguishable from filesystem metadata and wrapper inspection.
- PATH resolution cannot be made safe without requiring explicit trusted executable configuration.
- A repo-local or relative `claude` can be selected.

## Spike 11: Lifecycle, Process Tree, Timeout, And Lock Failure

Success criteria:
- Harnessed child/grandchild processes are killed on timeout, verifier failure, Ctrl-C equivalent, and output flood limits, with no live descendants left.
- Single-flight lock has fail-fast busy, bounded wait, stale recovery with owner metadata, and owner-verified release.
- Partial stdout/stderr bytes survive failure, and completion fields distinguish complete process exit from killed/aborted streams.

Kill criteria:
- Cleanup requires detached/background semantics.
- A child or grandchild can keep running after Oracle reports failure.
- Stale locks require unaudited manual deletion.
