# Internal error codes

These codes are logged but not surfaced as user-visible banners. They feed dashboards and the release pipeline's SLO gate.

| Code | Source | Meaning |
|---|---|---|
| ERR_METRICS_FD_OPEN | metrics-collector | Failed to open a `/sys/fs/cgroup/.../...` file for one cgroup. Other cgroups still sampled. |
| ERR_METRICS_INOTIFY | metrics-collector | inotify watch failed; falls back to 30 s rediscover sweep. |
| ERR_CHECKPOINT_PERMISSION | session-checkpoint | Permission denied on vault path; falls back to `/run/ellul/checkpoints/`. |
| ERR_CHECKPOINT_REDACTED_CRITICAL | session-checkpoint | Loaded checkpoint had a redacted critical field; treated as no checkpoint. |
| ERR_CHECKPOINT_CORRUPT | session-checkpoint | Checkpoint JSON parse failed; file deleted; older turn tried. |
| ERR_CHECKPOINT_WRITE_FAILED | session-checkpoint | Catch-all write failure. |
| ERR_CHECKPOINT_ADAPTER_FAILED | session-checkpoint | Adapter serializer threw; thread continues; next restart re-sends last turn. |
| ERR_RATE_LIMIT | thread machine | Send failed with a recoverable rate-limit; `error_recoverable` state; user retry. |
| ERR_AUTH_TERMINAL | thread machine | Send failed with a terminal auth error; `error_terminal` state; requires re-auth. |
| ERR_BOOT | sandbox machine | Provisioning failed at boot phase. |
| ERR_PROVISIONING | sandbox machine | Generic provisioning failure. |
| ERR_PROCESS_DIED | pro_claude_slot machine | Slot process exited unexpectedly; collapses to `evicted`. |
| ERR_DAEMON_DIED | pool_scope machine | Pool daemon (opencode/cursor/codex) exited unexpectedly. |

Any operator action for these is the same: check the bridge event log:

```sh
tail -F /var/log/ellul/agent-bridge-events.jsonl | grep ERR_
```
