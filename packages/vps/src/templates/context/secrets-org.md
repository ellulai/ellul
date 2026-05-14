## Secrets & Environment Variables
NEVER create .env files (git hook blocks). Secrets are managed in Dashboard → synced to the server.

Secrets are managed at the org level and scoped per team namespace.
- **Org secrets**: available to all teams in the org
- **Team secrets**: scoped to a single team namespace
Access via Sovereign Gates (org-scoped).