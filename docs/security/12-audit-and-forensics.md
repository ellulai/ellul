# Audit and forensics

Two complementary audit systems:

1. **Sovereign Shield audit log** — application-level events, hash-chained for tamper-evidence.
2. **Linux auditd** — kernel-level syscall events, with immutable rules (`-e 2`).

Together, they enable forensic reconstruction of what happened on a VPS during an incident.

## Shield audit log

Implementation: `audit.service.ts` in Sovereign Shield. SQLite table `audit_log` in `/etc/ellul/shield-data/local-auth.db`.

### Schema

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,        -- unix ms
  event TEXT NOT NULL,                -- 'login.success', 'gate.granted', etc.
  details TEXT NOT NULL,              -- JSON: who, what, IP, sandbox, etc.
  prev_hash TEXT,                     -- SHA-256 of prev row's hash + this row's content
  hash TEXT NOT NULL                  -- SHA-256 of (prev_hash + canonical(this row))
);
CREATE INDEX idx_audit_timestamp ON audit_log (timestamp);
CREATE INDEX idx_audit_event ON audit_log (event);
```

### Events logged

Authentication:

- `login.success` (with credentialId, AAGUID, IP, deviceFingerprint)
- `login.failure` (with reason, IP)
- `recovery.success` / `recovery.failure`
- `tier.upgrade.standard_to_web_locked`
- `tier.upgrade.web_locked_to_private_locked` (sovereign transition)
- `tier.downgrade.web_locked_to_standard`
- `passkey.registered` / `passkey.revoked`
- `ssh_key.added` / `ssh_key.removed`

Gates:

- `gate.requested` (gate type, sandbox, reason)
- `gate.auto_granted` / `gate.user_granted`
- `gate.auto_denied` / `gate.user_denied`
- `gate.expired` / `gate.revoked`

Cross-project:

- `cross_project.scope_denied` (which gate, which sandbox, reason text)
- `cross_project.access_granted` (A → B)
- `cross_project.access_revoked`

Sensitive operations:

- `git.push` (project, branch, commit hash)
- `deploy.success` / `deploy.failed`
- `db.query` (sandbox, sql category, role, rowCount)
- `vault_secret.read` / `vault_secret.write`
- `app_secrets.read` (sandbox, requester)

Security:

- `service.health_degraded` (which service, why)
- `service.restarted` (which, by whom)
- `lockdown.triggered` (rare)

### Hash chain

Each row's `hash` is SHA-256 of `(prev_hash || canonical_json_of_row_without_hash)`. So:

- Row 1: `hash = SHA256("" || canonical_json(row1))`
- Row 2: `hash = SHA256(row1.hash || canonical_json(row2))`
- ...
- Row N: `hash = SHA256(row(N-1).hash || canonical_json(rowN))`

Modifying any historical row breaks all subsequent hashes. A verification pass detects:

```bash
GET /_auth/audit/verify
```

Iterates all rows, recomputes expected hash, returns first mismatch index.

The chain head's hash is reported in every heartbeat to API:

```json
{
  "auditChainHead": { "seq": 12345, "hash": "abc..." }
}
```

API stores the latest chain head per server. If a future heartbeat reports a hash that's not a successor of a previously-observed hash (or skips backwards), API alerts. This is cross-attestation: even if the local DB is tampered with, the API has historical witness.

### Hash chain limitations

- The agent (with same-user access in current architecture) could potentially write to the SQLite. But hash chain detects after-the-fact; the API witness reveals tampering.
- The chain is broken (rather than tampered) if the DB is rebuilt from scratch (e.g., LUKS volume restored from old snapshot). API sees "new chain"; manual verification needed.
- Hash chain doesn't prove WHO logged the event, only that no one altered it after.

### Querying the log

`GET /_auth/audit/log?event=gate.user_granted&since=...&limit=100` returns matching rows. Pagination by `id`.

For high-volume queries: query SQLite directly via `shield-pg-wrapper`-style helper.

## Linux auditd

Source: `/etc/audit/rules.d/ellul.rules`, applied during kernel hardening section. Kernel-level event recording.

### Why auditd in addition to Shield

- **Kernel events.** auditd captures events Shield can't see (file modifications by root, syscalls).
- **Tamper-evidence at OS level.** With `-e 2` (immutable), rules cannot be cleared without reboot.
- **Forensic standard.** Auditors expect auditd for compliance.

### Audit rules

Enable rules:

```
# Watch sensitive files
-w /etc/ellul/ -p wa -k ellul_etc
-w /etc/ellul-bootstrap/ -p wa -k ellul_bootstrap
-w /usr/local/bin/ -p wa -k ellul_bin

# Watch privilege escalation
-a always,exit -F arch=b64 -S setuid -k privesc
-a always,exit -F arch=b64 -S setgid -k privesc
-a always,exit -F arch=b64 -S setresuid -k privesc

# Watch xattr changes (chattr -i would show here)
-a always,exit -F arch=b64 -S setxattr -k xattr_change
-a always,exit -F arch=b64 -S removexattr -k xattr_change

# Watch mounts
-a always,exit -F arch=b64 -S mount -k mount_op
-a always,exit -F arch=b64 -S umount2 -k mount_op

# Make rules immutable until reboot
-e 2
```

`-e 2` is the immutability flag. After loading, rules cannot be cleared, only recovered after reboot.

### Querying auditd

```bash
# All events tagged ellul_etc
sudo ausearch -k ellul_etc -ts today

# Events for a specific binary
sudo ausearch -i -x /usr/local/bin/ellul-update-binary -ts recent

# Summary of events
sudo aureport --summary
```

### Persistence

`/etc/systemd/journald.conf.d/ellul.conf` keeps auditd logs persistent (`SystemMaxUse=200M`, `MaxRetentionSec=7day`). Logs survive reboots.

For longer retention, exfiltrate to control plane (not currently automatic; manual investigation pulls logs as needed).

## Forensic reconstruction

For a typical incident investigation:

1. **Identify the time window.** When did suspicious activity start?
2. **Pull Shield audit log** for the window: `GET /_auth/audit/log?since=...&until=...`.
3. **Pull auditd events**: `ausearch -ts <start> -te <end>`.
4. **Pull systemd journal** for affected services: `journalctl -u ellul-* -S <start> -U <end>`.
5. **Pull heartbeat history** (API-side): security violations, anomalies, IP changes.
6. **Cross-reference timestamps** across the four sources.

A typical timeline reconstruction:

- 14:00:00 — Shield: `login.success` user=alice IP=1.2.3.4
- 14:00:03 — auditd: `setuid` syscall (login session opening shell)
- 14:00:15 — Shield: `gate.user_granted` gate=db_write sandbox=sbx-abc
- 14:00:16 — auditd: `setgid` syscall (postgres role switch)
- 14:00:30 — Shield: `db.query` sandbox=sbx-abc category=write rowCount=42
- 14:01:00 — heartbeat: CPU spike, no other anomalies
- 14:05:00 — Shield: `gate.expired` gate=db_write
- 14:05:01 — auditd: `setuid` syscall (revoke role)
- ...

This level of detail enables answering questions like "did the agent execute commands during gate window X?" with evidence from independent sources.

## What forensics CANNOT prove

- **Who at the customer authorized.** The audit log shows the user account, not the human. If the human was coerced or their device stolen, the log shows their session.
- **Code execution semantics.** `db.query` is logged with category and rowCount, but the actual SQL is not unless explicitly captured. (Some queries log SQL; some don't, to avoid logging secrets passed as parameters.)
- **What the agent's reasoning was.** The chat log captures the prompt and response, but the agent's "thought process" is opaque.

## Cross-attestation with API

Every heartbeat carries `auditChainHead`. API stores the latest seen hash and seq.

If a heartbeat reports a hash that:

- Doesn't continue from the previously-observed hash (chain break).
- Has a `seq` lower than previously seen (rollback).

API marks the server as "audit chain divergence" and alerts. This catches:

- Local tampering (someone rewrote the audit DB).
- Audit DB rollback (someone restored an older copy).
- Database deletion + recreation (chain starts fresh).

Forensic teams investigating receive both the API's witness chain and the local chain to compare.

## What's logged in dashboard

The customer dashboard exposes a "Security Activity" view powered by the Shield audit log:

- Recent logins.
- Recent gate grants/denials.
- SSH key changes.
- Tier transitions.
- Cross-project access changes.

Customers can review their own audit trail and notice anything suspicious.

## Cross-references

- Shield internals: [02-sovereign-shield.md](./02-sovereign-shield.md).
- Heartbeat protocol: [../runtime/07-heartbeat-protocol.md](../runtime/07-heartbeat-protocol.md).
- Threat detection (anomaly heartbeats): [../abuse-protection/04-heartbeat-anomaly.md](../abuse-protection/04-heartbeat-anomaly.md).
