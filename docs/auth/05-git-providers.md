# Git Provider Integration

## Back Up Your Code — Zero Friction

ellul.ai lets users connect GitHub, GitLab, or Bitbucket from the dashboard and push code with one tap. The entire flow is designed for mobile — no terminal commands, no SSH key management, no git jargon. Users see "Back Up Code" instead of "commit and push".

For experienced developers, the same credentials work in the terminal for full git workflows.

> **Key Insight:** OAuth tokens are delivered to the VPS via the existing zero-knowledge secrets pipeline (RSA-4096 + AES-256-GCM). The platform never has plaintext access to git credentials on the server.

---

## How It Works

```
+------------------------------------------------------------------------+
|                     GIT PROVIDER FLOW                                   |
+------------------------------------------------------------------------+
|                                                                         |
|  1. User opens Git tab in dashboard                                     |
|     → Sees GitHub / GitLab / Bitbucket cards                            |
|                                                                         |
|  2. Taps "Connect GitHub"                                               |
|     → Redirects to GitHub OAuth (scope: repo,read:user)                 |
|     → GitHub redirects back with authorization code                     |
|     → API exchanges code for access token                               |
|     → Token stored in gitConnections table                              |
|                                                                         |
|  3. User picks a repo (or creates one)                                  |
|     → API lists repos using stored token                                |
|     → User taps a repo to link it                                       |
|                                                                         |
|  4. Credential delivery (zero-knowledge)                                |
|     → API returns token to frontend                                     |
|     → Frontend encrypts token with VPS public key (RSA-4096)            |
|     → Encrypted token stored as server secret (__GIT_TOKEN)             |
|     → VPS decrypts on next secrets sync                                 |
|     → VPS configures git credential helper                              |
|                                                                         |
|  5. User taps "Back Up Code"                                            |
|     → Dashboard queues push via heartbeat                               |
|     → VPS daemon runs: git add -A && git commit && git push             |
|     → User sees "Code backed up!" with link to repo                     |
|                                                                         |
+------------------------------------------------------------------------+
```

---

## Dashboard UX — Three States

The Git tab has three progressive states. Users advance through them naturally.

### State 1: No Provider Connected

Shows three tappable provider cards:

| Provider | Scopes Requested | Description |
|----------|-----------------|-------------|
| **GitHub** | `repo`, `read:user` | Most popular for open source and teams |
| **GitLab** | `api` | Built-in CI/CD and DevOps platform |
| **Bitbucket** | `repository:write` | Integrated with Atlassian tools |

Each card navigates to `GET /api/git/connect/:provider`, which redirects to the provider's OAuth authorize URL.

A note below the cards reads: *"Your credentials are encrypted end-to-end"*.

### State 2: Provider Connected, No Repo Linked

Shows:
- Connected provider badge with avatar and `@username`
- Search bar for filtering repos
- Scrollable repo list (name, private/public badge, last updated)
- "New" button to create a repo directly from the dashboard

Tapping a repo triggers the **link flow** — the critical path that delivers credentials to the VPS.

> **Web Locked Tier:** Linking and unlinking repos requires passkey confirmation (Face ID/Touch ID) via the VPS bridge iframe. This prevents a compromised API from linking malicious repos without biometric verification. See [Security: Passkey-Protected Git Linking](#passkey-protected-git-linking-web-locked) below.

### State 3: Repo Linked

Shows:
- Linked repo card with provider icon, full name, external link
- **"Back Up Code"** primary button (large, emerald, centered)
- Last backup timestamp
- Secondary actions: Pull, Change Repo, Unlink

> **Design Decision:** The UI deliberately avoids git terminology. "Back Up Code" instead of "Push", "Pull" stays as "Pull" since it's intuitive enough. No mention of commits, branches, or remotes in the primary interface.

---

## OAuth Architecture

### Why Separate from Login OAuth

ellul.ai uses GitHub/Google OAuth for **login** (via Better Auth) with minimal scopes (`user:email`, `read:user`). Git integration needs **repo access** — a much broader permission.

Keeping them separate means:
- Users aren't forced to grant repo access at sign-up
- Different OAuth client IDs and secrets
- Git access is opt-in from the dashboard
- Login OAuth can never accidentally leak repo access

### Provider Configuration

Each provider requires a separate OAuth application:

```
# .env
GITHUB_GIT_CLIENT_ID=       # GitHub OAuth App (callback: /api/git/callback/github)
GITHUB_GIT_CLIENT_SECRET=
GITLAB_CLIENT_ID=            # GitLab OAuth App (callback: /api/git/callback/gitlab)
GITLAB_CLIENT_SECRET=
BITBUCKET_CLIENT_ID=         # Bitbucket OAuth Consumer (callback: /api/git/callback/bitbucket)
BITBUCKET_CLIENT_SECRET=
```

### OAuth Callback Flow

```
GET /api/git/connect/:provider
  → Build authorize URL with state (base64url-encoded userId for CSRF)
  → Redirect to provider

GET /api/git/callback/:provider?code=...&state=...
  → Validate state matches session userId (CSRF protection)
  → Exchange code for access token
  → Fetch user profile (username, avatar)
  → Upsert into gitConnections table
  → Redirect to /dashboard?tab=git&connected=github
```

---

## Zero-Knowledge Credential Delivery

This is the most architecturally critical part. The platform stores the OAuth token in `gitConnections` for repo listing, but the VPS receives its copy through the **encrypted secrets pipeline** — identical to how API keys are delivered.

```
+-----------------------------------------------------------------------+
|                 CREDENTIAL DELIVERY FLOW                               |
+-----------------------------------------------------------------------+
|                                                                        |
|  Frontend (Browser)                                                    |
|  ├─ Receives tokenForEncryption from link API response                 |
|  ├─ Fetches VPS public key (RSA-4096)                                  |
|  ├─ Generates random AES-256 key                                       |
|  ├─ Encrypts token with AES-256-GCM                                    |
|  ├─ Encrypts AES key with RSA-OAEP                                     |
|  └─ Stores as server secret via POST /api/servers/:id/secrets          |
|                                                                        |
|  Secrets stored (all encrypted, platform cannot read):                 |
|  ├─ __GIT_TOKEN          OAuth access token                           |
|  ├─ __GIT_PROVIDER       "github" | "gitlab" | "bitbucket"            |
|  ├─ __GIT_REPO_URL       HTTPS clone URL                              |
|  ├─ __GIT_USER_NAME      Provider username                            |
|  ├─ __GIT_USER_EMAIL     User email for commits                       |
|  └─ __GIT_DEFAULT_BRANCH Default branch name                          |
|                                                                        |
|  VPS (on next secrets sync)                                            |
|  ├─ Decrypts secrets using private key                                 |
|  ├─ Configures git credential helper                                   |
|  ├─ Writes ~/.git-credentials                                          |
|  ├─ Sets git user.name and user.email                                  |
|  └─ Adds remote origin                                                 |
|                                                                        |
+-----------------------------------------------------------------------+
```

The `__` prefix on secret names is a convention to distinguish platform-managed git secrets from user-created secrets.

---

## API Routes

### OAuth Routes (`/api/git/`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/git/connections` | List connected providers + available providers |
| `GET` | `/api/git/connect/:provider` | Redirect to OAuth authorize URL |
| `GET` | `/api/git/callback/:provider` | Handle OAuth callback |
| `DELETE` | `/api/git/connections/:provider` | Disconnect provider (cascade deletes linked repos) |

### Repository Routes (`/api/git/`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/git/repos/:provider` | List repos (supports `?search=` query) |
| `POST` | `/api/git/repos/:provider` | Create new repo (name, isPrivate) |
| `GET` | `/api/git/servers/:serverId/link` | Get linked repo for server |
| `POST` | `/api/git/servers/:serverId/link` | Link repo to server (returns token for encryption). Web Locked: requires `X-VPS-Confirm-Token` header |
| `DELETE` | `/api/git/servers/:serverId/link` | Unlink repo from server. Web Locked: requires `X-VPS-Confirm-Token` header |
| `POST` | `/api/git/servers/:serverId/push` | Queue push via heartbeat |
| `POST` | `/api/git/servers/:serverId/pull` | Queue pull via heartbeat |
| `POST` | `/api/git/servers/:serverId/credentials-synced` | Mark credentials delivered + queue setup |

---

## Database Schema

### `gitConnections` — Provider connections (per user)

```typescript
gitConnections {
  id:                    text (UUID, PK)
  userId:                text (FK → users, cascade delete)
  provider:              enum ("github" | "gitlab" | "bitbucket")
  providerUsername:       text          // e.g., "octocat"
  providerAvatarUrl:     text
  accessToken:           text (NOT NULL) // API-side copy for repo listing
  refreshToken:          text
  accessTokenExpiresAt:  timestamp
  scope:                 text
  connectedAt:           timestamp
  updatedAt:             timestamp

  UNIQUE INDEX (userId, provider)
}
```

### `serverGitRepos` — Server-to-repo links

```typescript
serverGitRepos {
  id:                text (UUID, PK)
  serverId:          text (FK → servers, cascade delete)
  gitConnectionId:   text (FK → gitConnections, cascade delete)
  provider:          enum (denormalized)
  repoFullName:      text          // "octocat/hello-world"
  repoUrl:           text          // HTTPS clone URL
  defaultBranch:     text          // "main"
  isPrivate:         boolean
  credentialsSynced: boolean       // Whether token delivered to VPS
  linkedAt:          timestamp
  lastPushAt:        timestamp
}
```

### `servers` — New field

```typescript
pendingGitAction: text  // "push" | "pull" | "setup" | null
```

Follows the existing heartbeat command queue pattern used by `pendingKillPorts`, `pendingSecurityAction`, and `pendingDeploymentModel`.

---

## VPS-Side Git Setup

When the VPS daemon detects `__GIT_TOKEN` in the decrypted secrets, it runs the git-setup script:

1. **Configure identity** — `git config --global user.name` / `user.email`
2. **Install Sovereign Credential Helper** — A custom script at `/usr/local/bin/git-credential-ellul` that reads tokens from environment variables at runtime. No credentials are ever written to disk.
3. **Remove legacy credentials** — Deletes `~/.git-credentials` if it exists from older setups.
4. **Initialize repo** if no `.git` directory exists
5. **Configure remote** — `git remote add origin {REPO_URL}`

> **Security: No Tokens on Disk.** Unlike `git config credential.helper store` (which writes plaintext tokens to `~/.git-credentials`), the Sovereign Credential Helper reads `__GIT_TOKEN` from the daemon's process environment at runtime. If an attacker gains shell access, there is no credential file to steal. The token only exists in the daemon's process memory.

The helper follows git's credential helper protocol (`$1` = get/store/erase, stdin = attributes, stdout = credentials):

```bash
#!/bin/bash
# /usr/local/bin/git-credential-ellul

# Only handle "get". store/erase are no-ops (read-only helper).
if [ "$1" != "get" ]; then exit 0; fi
cat > /dev/null  # drain stdin (one provider per VPS, no host matching needed)

case "$__GIT_PROVIDER" in
  github)   USERNAME="x-access-token" ;;
  gitlab)   USERNAME="oauth2" ;;
  bitbucket) USERNAME="x-token-auth" ;;
  *) exit 0 ;;
esac

echo "username=$USERNAME"
echo "password=$__GIT_TOKEN"
```

### Git Flow Commands

The `git-flow` script provides these commands:

| Command | What it does |
|---------|-------------|
| `git-flow backup` | Commit + push. Fails cleanly if remote has diverged. |
| `git-flow force-backup` | Commit + `push --force-with-lease`. VPS is source of truth. |
| `git-flow pull` | `git pull origin HEAD --rebase` |

These are triggered by the dashboard via the heartbeat `gitAction` field.

### Push Conflict Handling

When the user taps "Back Up Code", the default behavior is a safe push. If the remote has changes that aren't on the VPS (e.g., someone edited a README on GitHub), the push is **rejected** and the user sees an error with a "Force Sync" button.

```
Safe Push (default)          Force Sync (opt-in)
─────────────────           ──────────────────
git push origin HEAD        git push --force-with-lease origin HEAD
  ↓                            ↓
  Fails if remote diverged     Overwrites remote
  Shows "Force Sync" button    VPS is source of truth
```

> **Design: VPS is King.** The "Force Sync" approach treats the user's device as the source of truth. If GitHub disagrees, GitHub is wrong — because the VPS has the code the user is actively working on.

---

## Heartbeat Integration

The push/pull flow uses the same heartbeat command queue pattern as port killing and security actions:

```
Dashboard                         API                           VPS Daemon
   │                               │                               │
   │  POST /git/servers/:id/push   │                               │
   │──────────────────────────────>│                               │
   │                               │  Set pendingGitAction="push"  │
   │                               │                               │
   │                               │  POST /heartbeat (30s cycle)  │
   │                               │<──────────────────────────────│
   │                               │                               │
   │                               │  Response: { gitAction: "push" }
   │                               │──────────────────────────────>│
   │                               │                               │
   │                               │  Clear pendingGitAction       │
   │                               │                               │
   │                               │         (VPS runs git-flow backup)
   │                               │                               │
```

---

## Security Considerations

### Trust Model

The OAuth token exists in two places:

1. **`gitConnections` table** (API-side) — Used for repo listing/creation. Same trust level as Better Auth's `accounts` table which already stores GitHub tokens. **High-value target** — see mitigations below.

2. **`serverSecrets` table** (encrypted) — Delivered to VPS via zero-knowledge pipeline. Platform cannot decrypt. VPS decrypts with its private RSA key.

### Idle Token Cleanup (Breach Blast Radius Reduction)

GitHub's `repo` scope is all-or-nothing — it grants access to every private repository. If the `gitConnections` table were breached, stolen tokens could access all repos.

**Mitigation:** Every token use (repo listing, linking, OAuth refresh) touches a `lastUsedAt` timestamp. A daily cron job (`POST /api/cron/git-token-cleanup`) **deletes connections** idle for 30+ days. This ensures:

- Tokens only exist for active users
- Dormant connections are auto-cleaned
- Users can re-connect at any time via OAuth

The cron job is at `apps/api/src/cron/git-token-cleanup.ts`.

### Sovereign Credential Helper (No Tokens on Disk)

The VPS never writes credentials to `~/.git-credentials`. Instead, a custom credential helper (`/usr/local/bin/git-credential-ellul`) reads `__GIT_TOKEN` from the daemon's process environment at git invocation time.

**Why this matters:** If an attacker gains shell access to the VPS (even non-root), there is no credential file to steal. The token only exists in the Ellul daemon's process memory, which is not accessible to other users.

### CSRF Protection

The OAuth `state` parameter contains `base64url(JSON({ userId }))`. On callback, the API verifies the state's userId matches the current session. This prevents attackers from completing OAuth flows on behalf of other users.

### Scope Separation

Git OAuth uses different client IDs from login OAuth. Even if a git OAuth token is compromised, it cannot be used for platform authentication. Conversely, login tokens cannot access repositories.

### Force Push Safety

Force push uses `--force-with-lease` (not `--force`). This ensures that if someone else pushed to the remote between the user's last fetch and their force push, git will still reject it — preventing accidental overwrites of third-party commits.

### Passkey-Protected Git Linking (Web Locked)

When a server is in `web_locked` tier, linking and unlinking git repos requires passkey confirmation (Face ID/Touch ID). This uses the same iframe bridge pattern as delete/rebuild operations.

**Threat model:** A compromised API could attempt to link a malicious repo to a user's server, potentially injecting backdoor code on the next pull. Passkey confirmation ensures only the device owner can authorize repo changes.

```
WEB LOCKED GIT LINK FLOW:

1. User selects repo in dashboard
2. Dashboard opens bridge iframe to VPS (_auth/bridge)
3. Bridge sends postMessage: { type: "authorize_git_link", repoFullName, provider }
4. VPS triggers Face ID / Touch ID (requires passkey session)
5. VPS generates single-use token (60s TTL, bound to repo + provider)
6. Bridge returns token via postMessage
7. Dashboard calls POST /api/git/servers/:id/link with X-VPS-Confirm-Token header
8. API verifies token with VPS (POST /_auth/git/verify-link-token)
9. If valid → link proceeds. Token is deleted (single-use).

Same pattern for unlink using authorize_git_unlink / verify-unlink-token.
```

**Token properties:**
- 32-byte cryptographically random hex
- 60-second TTL
- Single-use (deleted on verification)
- Bound to repo full name and provider (link) or just the operation (unlink)
- In-memory store with periodic cleanup

**Tier behavior:**
| Tier | Link/Unlink Behavior |
|------|---------------------|
| Standard | Direct — no passkey required |
| Web Locked | Requires passkey confirmation via VPS bridge |

**VPS endpoints (sovereign-shield):**
| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /_auth/git/authorize-link` | Passkey session | Generate link token (bound to repo + provider) |
| `POST /_auth/git/verify-link-token` | TLS only | Verify link token (called by platform API) |
| `POST /_auth/git/authorize-unlink` | Passkey session | Generate unlink token |
| `POST /_auth/git/verify-unlink-token` | TLS only | Verify unlink token (called by platform API) |

**Backward compatibility:** Old VPS instances without the `git-link-passkey` capability skip the passkey flow. The dashboard checks `useVpsFeature('git-link-passkey')` before requiring confirmation. See [capability-based-versioning.md](./capability-based-versioning.md).

### Audit Trail

All git operations are audit-logged:

- `git_provider_connect_started` — User initiated OAuth flow
- `git_provider_connected` — OAuth completed, token stored
- `git_provider_disconnected` — Provider unlinked
- `git_repo_created` — New repo created on provider
- `git_repo_linked` — Repo linked to server
- `git_repo_unlinked` — Repo unlinked from server
- `git_link_authorized` — Passkey-confirmed git link authorization (Web Locked, VPS audit)
- `git_link_token_verified` — Git link token verified by API (VPS audit)
- `git_link_token_mismatch` — Repo mismatch on token verification (VPS audit, potential attack)
- `git_unlink_authorized` — Passkey-confirmed git unlink authorization (Web Locked, VPS audit)
- `git_unlink_token_verified` — Git unlink token verified by API (VPS audit)
- `git_push_queued` — Push queued via heartbeat (includes `force: true` flag)

---

## File Map

```
apps/api/src/routes/git/
├── index.ts                      # Barrel export
├── oauth.ts                      # Connect/callback/disconnect routes
└── repos.ts                      # Repo CRUD + link/push/pull routes

apps/console/src/components/dashboard/
├── tabs/TabGit.tsx               # Main Git tab (3-state orchestrator)
└── git/
    ├── ProviderCard.tsx           # OAuth connect card with SVG logos
    ├── RepoPicker.tsx             # Searchable repo list
    ├── LinkedRepoCard.tsx         # Active repo card with backup button
    └── CreateRepoDialog.tsx       # New repo creation dialog

packages/vps/src/scripts/workflow/
├── git-flow.ts                   # Extended with backup + pull commands
└── git-setup.ts                  # VPS credential configuration script

packages/vps/src/services/sovereign-shield/src/routes/
├── git.routes.ts                 # Passkey-protected git link/unlink (Web Locked)
└── bridge.routes.ts              # Bridge iframe handlers (authorize_git_link/unlink)

packages/db/src/schema.ts         # gitConnections + serverGitRepos tables
apps/api/src/config/index.ts      # gitProviders config section
apps/api/src/app.ts               # Route registration
apps/api/src/cron/git-token-cleanup.ts  # Idle token cleanup (30-day expiry)
```

---

## Setup Checklist

To enable git provider integration:

1. **Create OAuth apps** on each provider you want to support:
   - GitHub: [github.com/settings/developers](https://github.com/settings/developers) → New OAuth App
   - GitLab: [gitlab.com/-/user_settings/applications](https://gitlab.com/-/user_settings/applications)
   - Bitbucket: Workspace settings → OAuth consumers

2. **Set callback URLs** for each provider:
   - GitHub: `https://api.ellul.ai/api/git/callback/github`
   - GitLab: `https://api.ellul.ai/api/git/callback/gitlab`
   - Bitbucket: `https://api.ellul.ai/api/git/callback/bitbucket`

3. **Add environment variables** to your API deployment:
   ```
   GITHUB_GIT_CLIENT_ID=...
   GITHUB_GIT_CLIENT_SECRET=...
   GITLAB_CLIENT_ID=...
   GITLAB_CLIENT_SECRET=...
   BITBUCKET_CLIENT_ID=...
   BITBUCKET_CLIENT_SECRET=...
   ```

4. **Run database migration** to create the new tables:
   ```bash
   pnpm --filter @ellul.ai/db db:push
   ```

5. **Deploy** — The Git tab appears automatically in the dashboard for all users. Providers that aren't configured show as "Coming soon".
