# gbrain Scrub Layer — Secret Redaction for Persistent Memory

## Threat Model

AI agents write conversation context to gbrain via MCP `put_page` calls. That context may contain secrets the agent encountered during its session: gate tokens, JWTs, API keys, environment variables, IPC tokens, credential session data. If these reach gbrain's Postgres database, they persist indefinitely and are retrievable by any future agent query.

**Security invariant**: Gate tokens, JWTs, IPC tokens, credentials, env var values, and API keys must NEVER reach gbrain's database.

## Architecture

```
Agent → MCP relay → agent-bridge MCP gateway
                         ↓
                    GbrainScrubber.ts
                    (intercepts write-path tools)
                         ↓
                    gbrain HTTP MCP (port 7704)
                         ↓
                    Postgres (gbrain database)
```

The scrub layer sits in the agent-bridge's MCP gateway, between tool dispatch and the gbrain HTTP server. It intercepts calls to write-path tools and redacts all string values in the tool arguments before forwarding.

Source: `packages/vps/src/services/backends/agent-bridge/src/application/mcp-tool/GbrainScrubber.ts`

## Write-Path Tools (Scrubbed)

| Tool | Risk | Scrub action |
| --- | --- | --- |
| `put_page` | Page content may contain secrets | Redact all string args |
| `sync_brain` | Git sync may pull secret-containing files | Redact all string args |
| `create_take` | Claim text may contain secrets | Redact all string args |
| `put_timeline_event` | Timeline entry may contain secrets | Redact all string args |

## Read-Path Tools (Pass Through)

`get_page`, `search`, `query`, `get_links`, `get_backlinks`, `think` — these read from the already-scrubbed database. No redaction needed on read.

## Redaction Patterns

Pattern-based redaction on all string values in tool arguments:

| Pattern | What it catches |
| --- | --- |
| `eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]*` | JWT tokens (header.payload.signature) |
| `sk-`, `pk_live_`, `ghp_`, `gho_`, `xoxb-`, `xoxp-`, `AKIA`, `sk-ant-` | Known secret prefixes (OpenAI, Stripe, GitHub, Slack, AWS, Anthropic) |
| `[0-9a-fA-F]{32,}` in assignment context | Hex secrets (API keys, tokens) |
| `[A-Za-z0-9+/]{40,}={0,2}` | Base64 keys (heuristic, 40+ chars) |
| `[A-Z_]+=<secret-prefix>.*` | Environment variable assignments |
| UUID in gate/token context | Gate tokens (128-bit, 5-min TTL) |
| Vault secret dictionary entries | Known secrets from shield's secret store |

The vault secret dictionary is the same source used by the `StreamingRedactionEngine` in shield-proxy. It provides exact-match redaction for secrets the platform knows about. The regex patterns provide structural matching for secrets the dictionary doesn't contain.

## Fail-Closed Semantics

If the scrubber encounters an error (dictionary unavailable, regex engine failure, malformed args), the write call is **denied entirely**. The agent receives an error response. The denial is logged for observability.

This is the critical safety property: a scrubber failure never results in unscrubbed data reaching gbrain.

## Defense in Depth

The scrub layer is one of four independent security boundaries:

| Layer | What it prevents |
| --- | --- |
| **Scrub middleware** | Secrets in MCP write-path arguments |
| **Network isolation** | Direct access to gbrain from namespaces (port 7704 localhost-only) |
| **DB credential isolation** | gbrain password file 600 root:root, only systemd unit reads it |
| **Gate system** | Unauthorized tool execution (db_write gate required for write tools) |

Each layer is independently sufficient for its specific threat. Together they provide redundant protection.

## Integration Point

In `McpGateway.ts`, before dispatching a tool call to gbrain:

```typescript
if (connectionId === GBRAIN_CONNECTION_ID && GBRAIN_WRITE_TOOLS.has(toolName)) {
  args = await scrubGbrainArgs(args);
}
```

The `GBRAIN_CONNECTION_ID` is a well-known constant (`__gbrain__`) set when the local gbrain connection is established in `IntegrationLoader.ts`.

## What Gets Replaced

Matched secrets are replaced with `[REDACTED]`. The replacement preserves the structure of the content (a page about "we decided to use JWT auth" still reads coherently) while removing the actual credential values.

## Observability

Each redaction event logs:
- Tool name and connection ID
- Number of redactions performed
- Pattern categories matched (JWT, prefix, hex, etc.)
- No secret values in the log (only category counts)
