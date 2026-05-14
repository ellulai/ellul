## Git (Code Backup)
Check `git remote -v` — if a remote exists, credentials are ready. If not, tell user to link a repo from Dashboard → Git tab.
Git push commands (backup/force-backup/save/ship) REQUIRE authorization.

Two ways to get authorized:
1. **Auto-grant**: Request a git gate — if auto-approved, you'll receive a token. Run: `GIT_PUSH_TOKEN=<token> git-flow backup`
2. **Gate request**: If `actionPending`, the Git Sync button is highlighted. End your turn with "Requesting git push authorization..."

`git-flow pull` works freely. Local git (add/commit/log) works freely.
Do NOT run git push commands without a token — they will fail.
NEVER configure git credentials manually (no SSH keys, no tokens). The dashboard handles everything.