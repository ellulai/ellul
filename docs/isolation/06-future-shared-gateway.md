# Future: shared gateway namespace (Phase 5b)

Status: planned, not yet implemented.

## The problem

Persistent namespaces hold ~500MB RAM each (anchor process holding mount + PID namespaces, plus per-project state). For a customer with 10 active projects, that's 5GB just for namespace anchors.

## The plan

Replace per-project namespaces with **one shared gateway namespace per VPS**, where projects are isolated by directory + env vars + process group.

```
[host]
  └─ shared gateway namespace (one per server)
       └─ /comms/team/<team-slug>/
       └─ /projects/<sbx-slug>/...
           └─ each project gets a directory; agent cd's into it
```

Inside the gateway:

- All project directories are visible.
- Network egress is the gateway's allowlist (intersection of all projects).
- Filesystem isolation by `cd` and shell wrapping (less strong than mount namespace).

## Trade-offs

### Pros

- ~0 RAM per project (gateway is shared).
- Faster context switches (no nsenter cost).
- Simpler comms channels (mounts already shared).

### Cons

- Filesystem isolation weaker (relies on $SHELL pwd, not kernel).
- A bug in the agent could traverse to another project's dir.
- Need additional ACLs to prevent cross-project read.

## Why this might be acceptable

- For org mode (Paperclip), team-level isolation is what matters; project-level cross-leak is less critical.
- ACLs on per-project dirs (different group ownership) provide a backup.
- The cost of per-project namespaces in production is real: customers complain about slow agent startup on multi-project VPSes.

## Status

Currently scoped. Not implemented. May ship in 2026 H2.

For history and design context: memory file `project_shared_gateway_ns_shell.md`.

## Cross-references

- Current namespace model: [01-namespace-script.md](./01-namespace-script.md).
- Cross-project: [04-cross-project-snapshots.md](./04-cross-project-snapshots.md).
- Org mode: [../products/04-agent-adapter.md](../products/04-agent-adapter.md).
