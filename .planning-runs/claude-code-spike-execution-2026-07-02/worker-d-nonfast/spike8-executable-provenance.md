# Spike 8 Executable Provenance

Generated: 2026-07-02T08:01:15.550Z

## Fixture Matrix

| Case | Outcome | Reason Codes | Resolved Path |
| --- | --- | --- | --- |
| absolute-safe-binary | allow | none | /home/ubuntu/.cache/oracle-spike-worker-d-exec-provenance/safe/bin/claude |
| audited-node-wrapper | allow_with_wrapper_audit | none | /home/ubuntu/.cache/oracle-spike-worker-d-exec-provenance/node-wrapper/bin/claude |
| relative-path | deny | relative_path_refused | claude |
| repo-local-shadow | deny | repo_local_path_refused | /data/projects/oracle/.planning-runs/claude-code-spike-execution-2026-07-02/worker-d-nonfast/generated/spike8-repo-shadow/claude |
| world-writable-component | deny | world_writable_path_component | /home/ubuntu/.cache/oracle-spike-worker-d-exec-provenance/world-writable/bin/claude |
| safe-symlink-chain | allow | none | /home/ubuntu/.cache/oracle-spike-worker-d-exec-provenance/safe/bin/claude |
| symlink-into-repo | deny | repo_local_path_refused | /data/projects/oracle/.planning-runs/claude-code-spike-execution-2026-07-02/worker-d-nonfast/generated/spike8-repo-shadow/claude |
| dangerous-shell-wrapper | deny | dangerous_shell_wrapper | /home/ubuntu/.cache/oracle-spike-worker-d-exec-provenance/shell-wrapper/bin/claude |
| not-executable | deny | not_executable | /home/ubuntu/.cache/oracle-spike-worker-d-exec-provenance/no-exec/bin/claude |

## Actual PATH Scan

| Case | Outcome | Reason Codes | Resolved Path |
| --- | --- | --- | --- |
| PATH 1 | allow | none | /home/ubuntu/.local/share/claude/versions/2.1.198 |

## Spawn Invariant

- Absolute resolved executable only
- child_process.spawn with shell:false
- Prompt bytes on stdin, never argv
- Deny repo-local, relative, world-writable, unsafe symlink, and dangerous shell wrapper candidates
