# Spike 11 Lifecycle And Lock Harness

Generated: 2026-07-02T08:01:46.306Z

## Lifecycle Cases

| Case | Exit Code/Signal | Killed | Reason | Stdout/Stderr Bytes | Child Alive | Descendants Alive | Events Complete |
| --- | --- | --- | --- | --- | --- | --- | --- |
| partial-hang | /SIGTERM | true | timeout | 35/0 | false | 0 | false |
| stdin-hang | /SIGTERM | true | timeout | 18/0 | false | 0 | false |
| nonzero | 42/ | false | none | 43/32 | false | 0 | false |
| flood | /SIGTERM | true | stderr_flood_limit | 2162688/2162688 | false | 0 | false |
| startup-mismatch | /SIGTERM | true | startup_mismatch | 95/0 | false | 0 | false |
| read-only-violation | /SIGTERM | true | read_only_violation | 115/0 | false | 0 | false |
| grandchild-ignore-term | /SIGKILL | true | timeout | 67/0 | false | 0 | false |

## Lock Cases

| Case | Result | Message |
| --- | --- | --- |
| happy-acquire | true |  |
| happy-release | true |  |
| fail-fast-contention | FABLE_LOCAL_BUSY | fable-local busy: lock held by pid 3831536 session held |
| wait-for-lock | true |  |
| stale-dead-pid-recovery | true |  |
| corrupt-lock | FABLE_LOCAL_LOCK_CORRUPT | fable-local lock is corrupt or unreadable at /data/projects/oracle/.planning-runs/claude-code-spike-execution-2026-07-02/worker-d-nonfast/generated/spike11/lock-drill/fable-local.lock/owner.json; recover with an audited lock recovery command |

## Notes

- POSIX process-group cleanup used detached child process groups and negative-pid SIGTERM/SIGKILL.
- Partial stdout/stderr byte counts are recorded even for killed verifier and timeout cases.
- Corrupt lock handling should block with recovery guidance, not silently delete.
