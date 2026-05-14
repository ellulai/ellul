# ellul-agent-namespace

The script that creates and manages per-project namespaces. Located at `/usr/local/bin/ellul-agent-namespace` (root:root 755). Source: `packages/vps/src/templates/helpers/agent-namespace/`.

Invoked via sudo from agent-bridge:

```bash
sudo /usr/local/bin/ellul-agent-namespace <action> --project <slug> [other flags]
```

Actions: `setup`, `enter`, `spawn`, `teardown`.

## Action: setup

Creates a persistent namespace. Runs once per project.

```
1. Concurrent setup lock (mkdir atomic) at /run/.ns-lock-<project>.
2. Clean stale state from previous crashes.
3. Parse pre-computed config from agent-bridge:
   - shared projects + preview ports
   - readable namespaces (org mode)
   - comms channels (org mode)
   - BYOK detection (/etc/ellul/shield-data/.byok-active)
4. Run network setup (host-side: veth, iptables FORWARD, /etc/hosts injection).
5. Configure preview DNAT rules.
6. Generate cleanup script (iptables delete rules for teardown).
7. Launch anchor process:
   nsenter --net=/var/run/netns/<ns> -- unshare --mount --pid --fork -- bash -c '
     # ... mount namespace setup ...
     touch /tmp/.ns-ready-fifo
     sleep infinity
   '
8. Wait for readiness signal via FIFO (60s timeout).
9. Write anchor PID to /run/.ns-<project>/anchor.pid.
10. Mark ready: touch /run/.ns-ready-<project>.
11. Apply cgroup limits if configured.
12. Clean stale .ns-cmd-* files older than 60 min.
```

The anchor process holds the namespace open. While alive, all `enter` calls reuse it.

## Action: enter

Fast reuse of the persistent namespace. Target: ~50ms.

```
1. Validate flags: --env-file, --thread-id, --cmd-file.
2. Validate thread ID format: ^[0-9a-f]{24}$ (24 hex chars exact).
3. Validate env file:
   - Exists?
   - NOT a symlink?
   - realpath -e canonicalizes to /tmp/.ns-env-*?
   - Owned by SVC_USER (not root, prevents symlink-to-privileged escalation)?
4. Same for cmd-file if provided.
5. Read anchor PID from /run/.ns-<project>/anchor.pid.
6. Verify anchor is alive (kill -0 $PID).
7. Copy env file into namespace via /proc/$ANCHOR_PID/root path:
   cp -P <env> /proc/$ANCHOR_PID/root/<NS_ENV_PATH>   # -P refuses symlinks
   rm -f <env>                                          # delete host copy
8. Copy pre-escaped args file similarly.
9. Copy cmd file if provided.
10. Per-thread isolation: secondary unshare --mount inside the namespace if thread ID present.
11. Execute via nsenter:
    nsenter --target $ANCHOR_PID --mount --pid -- unshare --pid --fork -- ...
12. Inside, remount /proc for Go binaries.
13. Source env file, then delete it.
14. Set ZEROCLAW_WORKSPACE, cd to project.
15. Apply seccomp-BPF: exec /usr/local/bin/ellul-seccomp-exec runuser -l $SVC_USER -c "$_CMD".
```

The validation at step 3 (defense against symlink attacks) is critical. If we naively `cat <envfile>` without checking for symlinks, an attacker could symlink `/tmp/.ns-env-evil` to `/etc/shadow` and read it through us.

## Action: spawn

Creates fresh namespace per invocation. ~1s on ARM. Used when persistent isn't available.

```
1. Validate flags.
2. Derive deterministic NS_IP via HMAC-SHA256(jwt-secret, projectSlug).
3. Create host-side network: veth pair, IP assignment, iptables rules, /etc/hosts injection.
4. Write cleanup script.
5. Set cleanup trap.
6. Enter named netns + create mount/PID:
   nsenter --net=/var/run/netns/<ns> -- unshare --mount --pid --fork -- bash -c '
     # Inside the unshare:
     mount --make-rprivate /
     mount -t tmpfs -o size=512M tmpfs /run/.ns-<ns>
     mount --bind <project-dir> <project-dir>
     # rsync shared snapshots
     # bind-mount thread dir
     # tmpfs overlays for dotdirs
     # remount /home read-only
     # /etc/hosts and /etc/resolv.conf
     # tmpfs hide for shield-data, vaults, /run/shield
     # exec runuser with seccomp prefix
   '
```

Each spawn:

- Computes namespace IP fresh.
- Sets up veth, iptables.
- Creates mount tree.
- rsync's shared snapshots from scratch.
- Tears down on exit.

## Action: teardown

Removes the persistent namespace. Triggered on project deletion or sandbox-destroy command.

```
1. Read anchor PID from /run/.ns-<project>/anchor.pid.
2. Send SIGTERM, wait 5s, SIGKILL if needed.
3. Run cleanup script (deletes iptables rules, /etc/hosts entries).
4. Delete /var/run/netns/<ns>.
5. Delete veth pair.
6. Remove /run/.ns-<project>/.
7. Remove /run/.ns-ready-<project>.
8. Remove /run/.ns-lock-<project>.
```

## Validation rules (defense in depth)

```bash
# Project slug
[[ "$PROJECT" =~ ^sbx-[a-z0-9]{7}$ ]] || die "invalid project slug"

# Thread ID
[[ "$THREAD_ID" =~ ^[0-9a-f]{24}$ ]] || die "invalid thread id"

# Env file path
[[ "$ENV_FILE" == /tmp/.ns-env-* ]] || die "invalid env file path"
[[ ! -L "$ENV_FILE" ]] || die "env file is symlink"
[[ "$(realpath -e "$ENV_FILE")" == /tmp/.ns-env-* ]] || die "realpath escapes /tmp/.ns-env-*"
[[ "$(stat -c '%U' "$ENV_FILE")" == "$SVC_USER" ]] || die "env file not owned by svc user"
```

The slug regex `^sbx-[a-z0-9]{7}$` blocks path traversal (`..`, `/`).

The env file checks block symlink-to-privileged-file attacks.

The TOCTOU (Time-Of-Check-Time-Of-Use) defense uses `cp -P` (refuses to follow symlinks) so even if a symlink is created between check and copy, the copy fails.

## Cross-references

- Mount layout: [02-mount-layout.md](./02-mount-layout.md).
- Network: [03-network-namespace.md](./03-network-namespace.md).
- Cross-project: [04-cross-project-snapshots.md](./04-cross-project-snapshots.md).
- Security view: [../security/10-namespace-isolation.md](../security/10-namespace-isolation.md).
