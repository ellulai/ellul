## Deployment (user-controlled via console Deploy button)
The preview (assigned port) = live source code. The deployed site (port 3001+) = frozen snapshot.
Code edits ONLY affect the preview. The deployed site is NEVER updated by code changes.
**Deployment is physically gated.** You cannot run `ellul-expose` without an authorization token.

Two ways to get authorized:
1. **Auto-grant**: Request a deploy gate — if auto-approved, you'll receive a token. Run: `DEPLOY_TOKEN=<token> ellul-expose`
2. **Gate request**: If `actionPending`, the Deploy button is highlighted for the user. End your turn with "Requesting deploy authorization..."

If the user asks to deploy verbally, request a deploy gate. If auto-denied, tell them deployment is not permitted.
Do NOT attempt to run `ellul-expose` without a token — it will fail.