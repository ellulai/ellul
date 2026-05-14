# Cross-project snapshots

The `.shared/<slug>` mechanism. When user grants project A read access to project B, A's namespace gets a frozen, read-only snapshot of B's source.

## Why snapshot, not bind mount

A bind mount of B's directory into A's namespace would make B's live changes visible to A. That's:

- Unstable (if B's agent edits while A reads, A sees inconsistent state).
- Confusing (A gets racy errors about files appearing/disappearing).
- Insecure (B could potentially time A's reads to leak signals).

A snapshot:

- Is consistent (rsync at namespace setup).
- Is immutable from A's perspective.
- Doesn't risk symlink-based attacks (because rsync `--no-links` rejects all symlinks).

## rsync invocation

```bash
rsync -aq --no-links --max-size=50m \
  --exclude '.env*' \
  --exclude '.envrc' \
  --exclude '.ENV*' \
  --exclude 'credentials.json' \
  --exclude 'service-account.json' \
  --exclude '.npmrc' \
  --exclude '.pypirc' \
  --exclude '.netrc' \
  --exclude '.htpasswd' \
  --exclude '.pgpass' \
  --exclude '.zeroclaw' \
  --exclude '.claude' \
  --exclude '.codex' \
  --exclude '.config' \
  --exclude '.cursor' \
  --exclude '.vscode' \
  --exclude '.idea' \
  --exclude '.docker' \
  --exclude 'node_modules' \
  --exclude '.yarn' \
  --exclude '.pnpm-store' \
  --exclude '.git/objects' \
  --exclude '.git/lfs' \
  /home/dev/projects/sbx-bbbbb/ /run/.ns-<a>/scratch/shared-0/
```

`-a` (archive): preserves permissions, timestamps, ownership.

`-q` (quiet): no progress output.

`--no-links`: rejects all symlinks. Symlink → secret-file attacks fail.

`--max-size=50m`: skips files larger than 50MB. Prevents bloat from binary blobs.

### Excluded patterns

By category:

**Environment variables and secrets:**

- `.env*`, `.envrc`, `.ENV*`
- `credentials.json`, `service-account.json`
- `.npmrc`, `.pypirc`, `.netrc`, `.htpasswd`, `.pgpass`

**Config dirs (often contain secrets):**

- `.zeroclaw`, `.claude`, `.codex`, `.config`, `.cursor`, `.vscode`, `.idea`, `.docker`

**Dependencies (large, easily reproducible):**

- `node_modules`, `.yarn`, `.pnpm-store`

**Git internals (large objects):**

- `.git/objects`, `.git/lfs`

The rationale: source code is the legitimate cross-project artefact. Secrets, build artefacts, and dependencies are not.

## Bind mount

After rsync:

```bash
mount --bind /run/.ns-<a>/scratch/shared-0 /home/dev/projects/.shared/sbx-bbbbb
mount -o remount,bind,ro /home/dev/projects/.shared/sbx-bbbbb
```

Read-only. Agent in A cannot modify B's snapshot.

## Preview URL file

If sharePreview is enabled, the snapshot includes a `.preview-url` file:

```
.preview-url:
  http://10.200.x.y:4012
```

Plus the network DNAT rule (see [03-network-namespace.md](./03-network-namespace.md)) lets A reach B's preview port.

## Refresh cadence

Persistent namespaces refresh snapshots periodically. The reconciler in agent-bridge re-runs setup every 30s, which re-rsyncs.

For ephemeral spawns: snapshot is fresh per spawn.

## Cross-project gate denial

Even with read access, A's agent cannot use B's content as basis for gate requests against B's data. See [../security/08-cross-project-isolation.md](../security/08-cross-project-isolation.md).

## Configuration

`/etc/ellul/shield-data/cross-project-access.json`:

```json
{
  "sbx-aaaaaaa": [
    { "project": "sbx-bbbbbbb", "preview": true },
    { "project": "sbx-ccccccc", "preview": false }
  ],
  "sbx-ddddddd": []
}
```

`sbx-aaaaaaa` has read access to both `sbx-bbbbbbb` (with preview) and `sbx-ccccccc` (no preview).

`/etc/ellul/shield-data/preview-ports.json`:

```json
{ "sbx-bbbbbbb": 4001, "sbx-ccccccc": 0 }
```

Maps slug to its preview port (or 0 if no preview running).

Both files are written by agent-bridge based on user-granted permissions.

## Test coverage

108 tests across `cross-project-scope-confusion`, `redteam`, `flag`, `gate-scope-check`, `tool-resolver-scope-confusion`. Documented in [../security/08-cross-project-isolation.md](../security/08-cross-project-isolation.md).

## Cross-references

- Security perspective: [../security/08-cross-project-isolation.md](../security/08-cross-project-isolation.md).
- Network DNAT: [03-network-namespace.md](./03-network-namespace.md).
- Mount tree: [02-mount-layout.md](./02-mount-layout.md).
