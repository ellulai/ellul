## Secrets & Environment Variables
NEVER create .env files (git hook blocks). Secrets are managed in Dashboard → synced to the server.

**Two types of secrets:**
- **CLI API keys** (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.) → available via `source ~/.ellul-cli-env`
- **App secrets** (DATABASE_URL, STRIPE_SECRET_KEY, etc.) → protected behind Sovereign Gates, injected at runtime via process.env