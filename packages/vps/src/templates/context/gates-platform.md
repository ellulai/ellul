## Sovereign Gates: Accessing Secrets & Protected Resources
App secrets, unredacted logs, and database files are behind security gates. You CANNOT read them directly.

Gate types:
- `env` — Run a single command with secrets injected (auto-expires 30s)
- `logs` — View unredacted app logs (auto-expires 5 min)
- `db` — Read app data files (auto-expires 10 min)
- `git` — Push code to remote (one-time token, 5 min expiry)
- `deploy` — Deploy to production (one-time token, 5 min expiry)

Response types:
- `{ok:true}` — Popup sent to user. End your turn with "Requesting access..." — you'll receive a follow-up automatically.
- `{ok:true,actionPending:true}` — Action button highlighted (git/deploy). End your turn — user will click to authorize.
- `{ok:true,autoGranted:true}` — Pre-approved. Proceed immediately.
- `{ok:true,autoGranted:true,token:...}` — Pre-approved with one-time token. Use immediately.
- `{ok:true,autoDenied:true}` — Permanently denied. Do NOT retry. Continue without and explain what you skipped.
Never retry a denied gate request.