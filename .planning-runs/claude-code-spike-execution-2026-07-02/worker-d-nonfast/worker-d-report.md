# Worker D Report: Spikes 7, 8, 11

Date: 2026-07-02
Agent: RedCondor
Scope: planning evidence only. No product code changed. No live Claude prompt was run. Fake executables were classified but not executed.

## Preregistered Criteria

Full preregistration is in `preregistration.md`.

Success target:
- Prove local-owner/transport decisions before `claude` spawn.
- Prove executable provenance policy can distinguish safe installs from repo-local/relative/world-writable/symlink/wrapper hazards.
- Prove attached lifecycle cleanup can kill children and grandchildren, preserve partial bytes, and release/recover a single-flight lock.

Kill target:
- Kill or narrow `fable-local` if same-user locality cannot be proven, malicious and valid `claude` executables are indistinguishable, descendants can survive reported failure, or stale locks need unaudited manual deletion.

## Commands Run

- Read instructions: `sed -n ... AGENTS.md`, `SPIKE.md`, `docs/plans/claude-code-subscription-adapter.md`.
- Mapped seams with `rg`, `nl -ba`, and `sed` across `bin/oracle-cli.ts`, `src/cli/*`, `src/mcp/*`, `src/remote/*`, `src/browser/*`, `src/sessionManager.ts`, `src/sessionStore.ts`, `src/oracle/claude.ts`, and provider-boundary modules.
- Ran harnesses:
  - `node .planning-runs/.../worker-d-nonfast/spike7-local-owner-transport-matrix.mjs`
  - `node .planning-runs/.../worker-d-nonfast/spike8-executable-provenance.mjs`
  - `node .planning-runs/.../worker-d-nonfast/spike11-lifecycle-lock-harness.mjs`

## Code Evidence

- `EngineMode` is currently only `api | browser` (`src/cli/engine.ts:3`); Fable needs a new lane/engine boundary, not reuse of `api`.
- `src/oracle/claude.ts` is Anthropic API client code (`fetch` to `/v1/messages`), so it must not be used for subscription CLI execution.
- Active CLI sessions create session metadata before detach/execute (`bin/oracle-cli.ts:2509`) and restart does the same (`bin/oracle-cli.ts:2869`). Fable guard should run before both points.
- Detached workers use `spawn(..., { detached: true, stdio: "ignore" })` and `unref()` (`src/cli/detachedSession.ts:33`). Fable v1 should block this Oracle background/session-worker path.
- MCP is stdio today (`src/mcp/server.ts:35`), but `consult` creates sessions before execution (`src/mcp/tools/consult.ts:767`) and can launch detached browser workers (`src/mcp/tools/consult.ts:799`). Fable MCP must guard before session creation and refuse detached mode.
- `oracle serve` is a network browser service with busy state (`src/remote/server.ts:115`) and binds a server (`src/remote/server.ts:400`). It is a hard refuse context for local Claude Code.
- Browser leases provide a useful lock precedent: owner metadata, atomic mutation lock, stale/dead-pid handling, and recovery command (`src/browser/leases.ts:126`, `src/browser/leases.ts:423`).
- Current provider boundary has Claude as `user_cli` with `claude_code_subscription_cli` (`src/oracle/v18/provider_boundaries.ts:93`), but the API substitution guard only lists `claude_code_opus`, not `claude_code_fable_5` (`src/oracle/api_substitution_guard.ts:39`).

## Fixture Matrix

Spike 7 transport matrix (`spike7-transport-matrix.json`):
- Allowed: local CLI foreground, local CLI piped, restart-attached, MCP stdio, MCP local socket with verified peer credentials.
- Refused: detached/session worker, local socket without peer credentials, network MCP, `oracle serve`, router, bridge, remote browser, remote Chrome.
- Host facts: Linux, uid/gid `1000`, user `ubuntu`, no `SUDO_USER`; repo and `~/.oracle` are same uid.

Spike 8 executable matrix (`spike8-executable-provenance.json`):
- Allowed: absolute safe binary, safe symlink to safe binary, audited Node wrapper.
- Denied: relative path, repo-local shadow, world-writable component, symlink into repo, dangerous shell wrapper using `$PWD`, non-executable file.
- Actual PATH scan found `/home/ubuntu/.local/bin/claude -> /home/ubuntu/.local/share/claude/versions/2.1.198`, classified allow from metadata only. It was not executed.

Spike 11 lifecycle/lock matrix (`spike11-lifecycle-lock-results.json`):
- Timeout partial-line and stdin-hang cases were killed with SIGTERM; partial stdout bytes were preserved.
- Startup mismatch and read-only violation were killed with SIGTERM after visible event inspection.
- Output flood crossed 2 MB on stdout/stderr and was killed; streams/events marked incomplete.
- Grandchild ignoring SIGTERM required SIGKILL; no descendant remained alive.
- Nonzero exit preserved stdout/stderr and marked non-success with complete streams.
- Lock drill covered happy acquire/release, fail-fast busy with owner metadata, bounded wait, dead-pid stale recovery, and corrupt lock refusal with recovery guidance.

## Blocked OS-Specific Checks

- macOS process-tree behavior, quarantine/notarization metadata, and app/translocation were not available on this Linux host.
- Windows ACL/PATHEXT/case-insensitive env and process-tree termination were not exercised.
- Real MCP local socket peer credentials were modeled, not exercised, because current Oracle MCP uses stdio.
- Router/hosted contexts were inspected as code paths, not exercised against a live router.

## Recommended Plan Changes

- Narrow v1 to attached local CLI plus local stdio MCP. Local sockets can be allowed later only with server-side peer credentials. Refuse network MCP, serve, router, bridge, remote browser, remote Chrome, detached workers, and `--exec-session` for Fable.
- Add a dedicated `fable-local` launch eligibility guard before session creation in CLI root, restart, MCP consult, doctor/probe, and before stored `--exec-session` execution.
- Use a separate Claude Code executable resolver. It should PATH-scan without executing, require absolute realpath, deny repo-local/relative/world-writable/unsafe symlink/dangerous wrapper paths, record symlink chain and stat metadata, and spawn with `shell: false` and prompt bytes on stdin only.
- If wrapper inspection cannot distinguish valid package-manager shims from malicious wrappers, require explicit trusted executable configuration for v1.
- Spawn the Claude child in its own POSIX process group for cleanup while keeping Oracle attached and waiting. On SIGINT/timeout/verifier failure, send SIGTERM then SIGKILL to the process group; Windows needs a separate job-object/taskkill plan.
- Add a `fable-local` single-flight lock separate from browser leases. Store owner pid, uid, session id, cwd, executable realpath, created time, and token. Default to fail-fast busy; optional `--wait-for-lock` must be bounded. Dead-pid stale recovery is OK; corrupt lock should block with an audited recovery command.
- Persist failure artifacts on every terminal path: raw stdout, raw stderr, normalized events, adapter metadata, lock owner snapshot, and termination trace. Killed or verifier-aborted runs must report `streamsComplete:false` and `eventsComplete:false`.
- Add `claude_code_fable_5` to provider-boundary/API-substitution metadata; do not reuse `claude_code_opus` or Anthropic API routing.

## Files Created

- `preregistration.md`
- `spike7-local-owner-transport-matrix.mjs`
- `spike7-transport-matrix.json`
- `spike7-transport-matrix.md`
- `spike8-executable-provenance.mjs`
- `spike8-executable-provenance.json`
- `spike8-executable-provenance.md`
- `generated/spike8-repo-shadow/claude`
- `spike11-lifecycle-lock-harness.mjs`
- `spike11-lifecycle-lock-results.json`
- `spike11-lifecycle-lock-report.md`
- `worker-d-report.md`
