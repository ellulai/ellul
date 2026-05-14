# Mount layout inside namespace

What the agent sees from inside its project's namespace.

## Spawn-mode mount tree

```
/                                    (private from unshare --mount)
├── /proc                            (private /proc, hidepid=2)
├── /tmp                             (tmpfs, 256M, ephemeral)
├── /etc/resolv.conf                 (bind from scratch/dns/resolv.conf, points to 8.8.8.8)
├── /etc/ellul/shield-data           (tmpfs empty, mode 000) ← hides Shield secrets
├── /var/lib/ellul-shielded          (tmpfs empty, mode 000) ← hides app vaults
├── /run/shield                      (tmpfs empty, mode 000) ← hides IPC tokens
├── /home/dev                        (host's home, bind-mounted, read-only via remount)
│   ├── projects/
│   │   ├── sbx-aaaaa                (THIS project, bind-mount writable)
│   │   ├── .shared/
│   │   │   ├── sbx-bbbbb            (read access via cross_project_access — read-only snapshot)
│   │   │   └── sbx-ccccc            (read-only snapshot)
│   │   ├── CLAUDE.md, AGENTS.md     (context files copied)
│   ├── .config                      (overlayfs: lower=host, upper=tmpfs scratch)
│   ├── .claude                      (overlayfs)
│   ├── .cursor                      (overlayfs)
│   ├── .ellul                       (overlayfs)
│   ├── .local                       (overlayfs)
│   ├── .zeroclaw                    (overlayfs)
│   ├── .cache                       (overlayfs)
│   ├── .gitconfig                   (bind from scratch/dotfiles, writable)
│   ├── .claude.json                 (bind from scratch/dotfiles, writable)
│   ├── .opencode                    (bind from host, read-only)
└── (rest of host root: usr, var, etc. — inherited from host)
```

## Why read-only home with overlays

The agent owns `/home/dev/`. Without isolation, it could write anywhere. Inside namespace:

1. `mount --bind /home/dev /home/dev` — creates a bind mount point.
2. Mount tmpfs upper layers for dotdirs that need writes (.config, .claude, etc.).
3. `mount -o remount,bind,ro /home/dev` — make the whole home tree read-only.
4. The tmpfs overlays from step 2 remain writable (they're independent mounts).

Result: agent can write to `.config` (overlay catches the write to tmpfs); cannot write to `/home/dev/some-other-file` (read-only bind).

Order matters: tmpfs overlays MUST be mounted BEFORE the read-only remount. Otherwise overlay creation fails.

## Specific writable bind mounts

`.gitconfig` and `.claude.json` are individual files (not directories), so overlayfs doesn't apply. We:

1. Copy host's `~/.gitconfig` to scratch dir.
2. Bind-mount scratch copy to `~/.gitconfig` inside namespace.
3. Agent writes to scratch (which is tmpfs, ephemeral on namespace exit).

## Tmpfs overlays for sensitive directories

```bash
mount -t tmpfs -o size=4k,nr_inodes=2,mode=000 tmpfs /etc/ellul/shield-data
mount -t tmpfs -o size=4k,nr_inodes=2,mode=000 tmpfs /var/lib/ellul-shielded
mount -t tmpfs -o size=4k,nr_inodes=2,mode=000 tmpfs /run/shield
```

These tmpfs are empty and mode 000 — agent can't even traverse them. Effectively, those host paths don't exist inside the namespace.

## .shared snapshots

When the user grants A read access to B:

```
1. agent-bridge config has cross-project-access for A → B.
2. Setup invokes:
   rsync -aq --no-links --max-size=50m \
     --exclude '.env*' --exclude 'credentials.json' \
     --exclude 'node_modules' --exclude '.git/objects' \
     /home/dev/projects/sbx-bbbbb/ /run/.ns-<a>/scratch/shared-0/
3. Bind mount: scratch/shared-0 → /home/dev/projects/.shared/sbx-bbbbb (read-only).
```

Read-only via remount-ro. Even if A's agent writes, EROFS.

For details: [04-cross-project-snapshots.md](./04-cross-project-snapshots.md).

## Cgroup limits

If configured (free tier), the namespace can be constrained via cgroup v2:

```bash
# /sys/fs/cgroup/coder.slice/coder-namespace-<slug>.scope
echo "80" > cpu.weight
echo "1G" > memory.high
```

Limits apply to all processes inside the namespace.

## Per-thread isolation

In enter mode, a secondary `unshare --mount` creates a thread-local mount namespace inside the project namespace. Used to bind-mount thread-specific state (e.g., `~/.ellul/threads/<id>/.claude/sessions/`):

```bash
unshare --mount -- bash -c '
  mount --bind <thread-dir>/.claude/sessions ~/.claude/sessions
  exec runuser -l dev -c "..."
'
```

So each chat thread has isolated CLI session state without polluting other threads.

## Cross-references

- Network: [03-network-namespace.md](./03-network-namespace.md).
- Cross-project snapshots: [04-cross-project-snapshots.md](./04-cross-project-snapshots.md).
- Security: [../security/10-namespace-isolation.md](../security/10-namespace-isolation.md).
