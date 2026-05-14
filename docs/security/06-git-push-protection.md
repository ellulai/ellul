# Git push protection

A 9-layer defense ensures the agent cannot push code (or read git credentials) without an explicit user-granted gate. Layers are independent: failure of any one does not collapse the system.

Implementation: `packages/vps/src/services/auth/sovereign-shield/src/services/git-credentials.service.ts`, `git.service.ts`, `workflow.routes.ts`.

## The threat

The agent has read and write access to project source code. If it could:

1. Read git credentials, OR
2. Issue git push commands directly,

it could exfiltrate code or push compromised commits to the customer's repo.

## The defense layers

### 1. Credentials in process memory only

Git credentials (GitHub token, SSH key passphrase, etc.) are never written to disk in plaintext. When the user grants the `git` gate:

- Shield generates a credential session UUID (128-bit).
- Shield stores `{ sessionId → { token: <plaintext>, createdAt, expiresAt }}` in process memory.
- Shield invokes `safeGitCmd` with `GIT_ASKPASS` set to a credential helper that talks to Shield via Unix socket.

The plaintext token never touches disk; never logs; never leaves the Shield process.

### 2. Credential sessions

Each credential session has a 128-bit UUID. The agent must present the UUID to use the credential. The UUID is single-use:

- Issued when user approves `git` gate.
- Consumed when git push completes.
- Auto-expired after 5 minutes if unused.
- Cannot be guessed (entropy-equivalent to brute-forcing AES-128).

The agent never sees the actual token, only the session ID.

### 3. Gate tokens

The agent's gate token (issued by Shield to the agent after user approval) is required to invoke git operations. Without the token:

- Shield's `/_internal/git-push` endpoint returns 403.
- Shield's `safeGitCmd` requires the token to attach a credential session.

The agent gets gate tokens only when user approves a `git` gate request. There is no auto-approve for git in standard config (though `allow_always` is technically possible).

### 4. Hardened git commands (`safeGitCmd`)

When git is invoked, it is invoked via `safeGitCmd`:

```bash
git \
  -c core.hooksPath=/dev/null \           # Block trojan hooks
  -c credential.helper= \                 # Clear ALL inherited helpers
  -c credential.helper=/usr/local/bin/git-credential-ellul \  # Force ours
  -c http.proxy= \                        # Block MITM proxy
  -c https.proxy= \                       # Block MITM proxy
  -c http.sslVerify=true \                # Force TLS validation
  -c gc.auto=0 \                          # Disable auto-gc (timing channel)
  -c protocol.version=2 \
  push origin main
```

Each `-c` flag has highest config precedence in git's hierarchy, overriding system, global, and local settings. An attacker who modifies `~/.gitconfig` cannot override these.

### 5. Fetch + rebase split

Pulling is two phases:

1. **Fetch** (read-only): `git fetch origin` with credentials.
2. **Delete credential session**.
3. **Rebase** (local, no credentials): `git rebase origin/main`.

If the rebase phase is hijacked (somehow), it cannot push because the credentials are already gone.

If the fetch phase is hijacked, it could only read (download objects from remote), not push.

### 6. Private key isolation (`shield` group)

The `node.key` (ML-KEM private), heartbeat key, and migration-signing key are at `/etc/ellul-bootstrap/` with `root:shield 640`.

- Shield-runner is in `shield`. Reads the keys to sign commands and decrypt commands.
- Agent (`dev`) is NOT in `shield`. POSIX denies.

This isn't directly a git protection, but it ensures that an attacker who steals git credentials cannot also steal the platform's signing keys (which would amplify the attack to fleet-wide).

### 7. Kernel ptrace isolation (`ptrace_scope=1`)

When `git push` runs, it is a child of `shield-runner`'s git wrapper, NOT of the agent. From the agent's perspective, `git push` is a sibling under systemd.

Without `ptrace_scope=1`, the agent could:

```bash
ptrace -p $(pgrep git-credential-ellul)  # attach to credential helper
# read /proc/<pid>/environ and /proc/<pid>/mem
# extract the credential before push completes
```

With `ptrace_scope=1`, only ancestor processes can ptrace. Sibling processes cannot. Defense holds via the kernel.

### 8. Coredump prevention

If git or the credential helper crashes mid-operation, the coredump could contain the credential. Three layers:

- `LimitCORE=0` in service unit.
- Kernel `core_pattern` redirects to `/etc/ellul/coredumps/core.%e.%p` (root:shield-runner 2770) — agent can't read.
- ulimit + ACLs as belt-and-suspenders.

### 9. Binary protection

The `git-credential-ellul` binary at `/usr/local/bin/` is owned by root and `chattr +i`. The agent cannot replace it. `ProtectSystem=strict` in systemd units mounts `/usr` read-only — even compromised root services cannot write here.

## How a git push actually works

```
[user wants to deploy code]
  ↓
User in dashboard: "Push my changes"
  ↓
API → VPS Shield: POST /_auth/gates/request { gate: "git", reason: "..." }
  ↓
Dashboard popup: "Allow git push?" → User approves
  ↓
Shield issues gate token to agent
  ↓
Agent runs: git push origin main (via safeGitCmd, with GIT_ASKPASS=...)
  ↓
git invokes /usr/local/bin/git-credential-ellul (the credential helper)
  ↓
Credential helper opens Unix socket to Shield
  ↓
Shield validates: gate token, credential session, expiry
  ↓
Shield returns plaintext token via socket (in-memory transit)
  ↓
git uses token, performs push
  ↓
Credential helper exits
  ↓
Shield deletes credential session
  ↓
Audit log: 'git.push' with branch, commit hash, timestamp
```

Anywhere along this chain, defenses fire:

- No gate token → `/_internal/git-push` 403.
- Gate token but invalid session → 403.
- Credential helper attempts to log token → no logging permission.
- Agent ptraces credential helper → kernel denies (ptrace_scope).
- Crash mid-push → coredump unreadable (shield-runner-owned).
- Hooks try to run → blocked (`core.hooksPath=/dev/null`).

## What the user sees

In the dashboard:

- "Allow git push?" popup with project name and commit summary.
- After approval, in-progress indicator.
- Success or detailed error.
- Audit history showing every approved push.

In the agent's chat:

- "I'm requesting permission to push your changes…"
- After approval/rejection, the agent reports outcome.

## What if the agent jailbreaks Shield itself?

A jailbroken Shield process could read `auth-secrets.json`, the JWT secret, the credential session map. This is the same-user-trust gap acknowledged in [13-known-limitations.md](./13-known-limitations.md).

Defense in depth here:

- Shield runs as `shield-runner`, separate from agent's `dev`.
- Shield is bundled and `chmod 755`; replacement requires root + auditd visibility.
- `chattr +i` on Shield's binary prevents in-place modification by even compromised root.
- Audit log entries are hash-chained; the chain head is cross-attested with the API on each heartbeat.

A breach of Shield is detectable; the platform sees the chain break and alerts.

## Documentation cross-reference

- Caddy + deploy gate: [07-deploy-protection.md](./07-deploy-protection.md).
- Cross-project git scope: [08-cross-project-isolation.md](./08-cross-project-isolation.md).
- Sovereign Shield internals: [02-sovereign-shield.md](./02-sovereign-shield.md).
- The `safeGitCmd` flags rationale: matches `safeGitCmd()` in `git-credentials.service.ts`.
