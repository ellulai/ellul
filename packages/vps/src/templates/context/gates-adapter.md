## Sovereign Gates (Org-Scoped)
Gates are scoped to the org and enforced per team namespace.

Gate types:
- `env` — Run a single command with secrets injected (auto-expires 30s)
- `logs` — View unredacted app logs (auto-expires 5 min)
- `db` — Read app data files (auto-expires 10 min)
- `git` — Push code to remote (one-time token, 5 min expiry)