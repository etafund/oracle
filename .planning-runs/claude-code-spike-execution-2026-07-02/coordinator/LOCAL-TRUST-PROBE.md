# Coordinator Local Trust Probe

Date: 2026-07-02
Scope: no-live evidence for Spikes 7, 8, and partial 11.

## Commands

```bash
namei -l /home/ubuntu/.local/bin/claude
namei -l /home/ubuntu/.local/share/claude/versions/2.1.198
stat -Lc '%a %U %G %F %n' /home /home/ubuntu /home/ubuntu/.local /home/ubuntu/.local/bin /home/ubuntu/.local/bin/claude /home/ubuntu/.local/share /home/ubuntu/.local/share/claude /home/ubuntu/.local/share/claude/versions /home/ubuntu/.local/share/claude/versions/2.1.198
getent group ubuntu
id
```

## Observed current executable

- `which claude`: `/home/ubuntu/.local/bin/claude`
- `realpath`: `/home/ubuntu/.local/share/claude/versions/2.1.198`
- Version: `2.1.198 (Claude Code)`
- Current user: `ubuntu`, uid `1000`, primary group `ubuntu`.
- `ubuntu` group entry has no additional listed members.

Path chain:

- `/home`: root-owned, `755`.
- `/home/ubuntu`: `ubuntu:ubuntu`, `750`.
- `/home/ubuntu/.local`: `ubuntu:ubuntu`, `700`.
- `/home/ubuntu/.local/bin`: `ubuntu:ubuntu`, `755`.
- `/home/ubuntu/.local/bin/claude`: symlink owned by `ubuntu:ubuntu` to the versioned executable.
- `/home/ubuntu/.local/share/claude`: `ubuntu:ubuntu`, `775`.
- `/home/ubuntu/.local/share/claude/versions`: `ubuntu:ubuntu`, `775`.
- `/home/ubuntu/.local/share/claude/versions/2.1.198`: `ubuntu:ubuntu`, `755`, regular file.

## Dry-run remote context observation

This repo/user config currently has a remote browser host configured. Without `--remote-browser off`, dry-run prints:

```text
Remote browser host detected: 127.0.0.1:9470
```

With `--remote-browser off`, dry-run remains local browser mode and does not print the remote-host line.

## Findings

- The installed Claude executable is not repo-local and resolves to an owner-local versioned file.
- The version directories are group-writable (`775`) but the group appears to be the user's primary group with no additional listed members. For this local developer deployment, this is a warning-level provenance issue rather than a release blocker.
- A production resolver should still reject world-writable components, repo-local executables, relative paths, unsafe symlink chains, and ownership by another non-root user.
- For `fable-local`, configured remote browser/serve/router context should be ignored or refused before spawn. A remote browser config being read during unrelated API/route checks is a current seam hazard.
- Effective uid is non-root here. Product guard should refuse uid 0 and should record uid, home owner, Oracle home owner, session dir owner, and transport kind before spawn.

## Recommended plan changes

- Add a safe executable resolver that records `path`, `realpath`, owner, mode, and symlink chain.
- Treat group-writable same-user primary-group directories as warning unless the group has other local members; reject world-writable directories by default.
- Add local transport facts to the lane gate: CLI local allowed, stdio MCP only after same-user launch proof, network/serve/router/remote browser refused for `fable-local`.
- Run lifecycle fake drills before implementation: timeout, nonzero exit, startup mismatch, output flood, lock contention, and child/grandchild termination.
