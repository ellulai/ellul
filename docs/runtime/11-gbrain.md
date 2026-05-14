# gbrain — Persistent Memory for AI Agents

gbrain (by Garry Tan) gives AI agents persistent, structured memory backed by Postgres + pgvector. One instance per VPS, shared across all projects. Agents read and write knowledge through MCP tools; the scrub middleware ensures secrets never reach the database.

Source: `/opt/ellul/gbrain/` (git clone from github.com/garrytan/gbrain).

## Availability

- **8GB+ RAM tier only.** Pre-installed on disk at provisioning for paid cloud_platform profiles.
- **Default OFF.** User opts in via console toggle (AI Tools card).
- Service stays disabled (`systemctl disable ellul-gbrain`) until toggled on.

## Architecture

```
Agent (in namespace)
  → MCP relay (port 7702)
    → agent-bridge MCP gateway
      → GbrainScrubber (redacts secrets from write-path calls)
        → gbrain HTTP MCP (127.0.0.1:7704)
          → Postgres (gbrain database, pgvector)
```

gbrain is unreachable from agent namespaces directly (port 7704 binds localhost only, namespace veths only reach port 7702). All access flows through the agent-bridge MCP gateway, which applies the scrub middleware and gate system.

## MCP Tools

**Read path** (auto-allowed, no scrubbing):
- `get_page`, `search`, `query` — page retrieval and hybrid search
- `get_links`, `get_backlinks` — knowledge graph traversal
- `think` — multi-hop synthesis across pages

**Write path** (gate-checked, scrubbed):
- `put_page` — create or update a knowledge page
- `sync_brain` — incremental git sync
- `create_take` — weighted claim with attribution
- `put_timeline_event` — append to page timeline

Write tools are classified as `db_write` capability and require the `db_write` gate.

## systemd Unit

```
ellul-gbrain.service
  After=postgresql.service ellul-sovereign-shield.service
  Slice=ellul-control-plane.slice
  ExecStartPre=gbrain migrate
  ExecStart=/usr/local/bin/bun run /opt/ellul/gbrain/src/index.ts serve --http --port 7704 --host 127.0.0.1
  MemoryHigh=192M (8GB) / 256M (16GB+)
  MemoryMax=256M (8GB) / 384M (16GB+)
  MemorySwapMax=0
```

Heap capped via `BUN_JSC_MAX_HEAP_SIZE` in `/etc/ellul/gbrain/env`.

## Database

- Database: `gbrain` (owned by `gbrain_app` role)
- Auth: scram-sha-256 password (stored at `/etc/ellul/gbrain/db-password`, 600 root:root)
- Extension: pgvector (1536-dimensional embeddings)
- Connection pool: 10 (default)
- Schema managed by gbrain's migration system (`gbrain migrate` in ExecStartPre)

## Embeddings (BYOK)

gbrain uses OpenAI `text-embedding-3-small` for vector search. The user's BYOK OpenAI key is read from `openclaw.json` and written to `/etc/ellul/gbrain/env` by the enforcer. If no key is set, gbrain starts with keyword search only (no vector search).

## Enable / Disable Flow

1. User toggles gbrain ON in console AI Tools card
2. API validates 8GB+ RAM, updates `servers.gbrain_enabled`, enqueues `update-features` command
3. Enforcer claims command, runs `systemctl enable --now ellul-gbrain.service`
4. Agent-bridge detects gbrain via `/etc/ellul/features.json`, connects MCP gateway
5. Agents can now use gbrain tools

Disable reverses: `systemctl disable --now`, agent-bridge disconnects.

State persisted in `/etc/ellul/features.json` for reboot survival.

## Security

See [../security/17-gbrain-scrub-layer.md](../security/17-gbrain-scrub-layer.md) for the full scrub layer architecture.

- Scrub middleware intercepts all write-path MCP calls, redacting secrets before they reach gbrain
- Network isolation: localhost-only binding, unreachable from namespaces
- DB credential isolation: password file 600 root:root
- HTTP access token for MCP auth (600 root:root)
- Gate system governs tool access (db_read / db_write gates)
- Fail-closed: redaction error → write denied

## Relationship to Scoped Knowledge Vault

gbrain is the MCP-accessible knowledge backend (store, index, retrieve). The Scoped Knowledge Vault (doc 16) is the policy-governed agent projection layer (controls what agents can see based on project scope). They complement each other.
