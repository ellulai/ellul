# ERR_CHECKPOINT_DISK_FULL

## What the user sees

Banner: "Vault disk full — checkpoints disabled until cleared." The thread keeps working; only checkpointing is disabled, so a bridge restart will lose recent turns for this thread.

## What the system did automatically

`SessionCheckpointService` caught `ENOSPC` writing to the vault. Failed over to `/run/ellul/checkpoints/` (tmpfs). Threads continue; new checkpoints land on tmpfs and are lost on reboot.

## What an operator should check

```sh
df -h /etc/ellul
du -sh /etc/ellul/shield-data/sessions/
ls -la /etc/ellul/shield-data/sessions/
```

Common causes:

- Vault under-sized.
- A specific thread accumulated huge checkpoint payloads (look at `du -h /etc/ellul/shield-data/sessions/* | sort -h | tail`).
- Old GC didn't run.

Free space:

```sh
find /etc/ellul/shield-data/sessions -name '*.tmp' -delete
```

If a single thread is huge, its serializer is misbehaving (failing redaction). Investigate before deleting.

## Validating chaos scenario

Unit test `session-checkpoint.service.test.ts > falls back to fallback root on permission denied` covers the fallback path.

## Past incidents

None yet.
