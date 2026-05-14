# Agent Bridge

WebSocket server on port 7700. Brokers chat messages between browser and CLI sessions. Spawns CLIs in per-project namespaces. Hosts MCP relay.

Source: `packages/vps/src/services/backends/agent-bridge/`.

## Roles

1. **WebSocket RPC server.** Browser → bridge → orchestration.
2. **CLI orchestration.** Per-thread sessions of opencode / claude / codex / gemini / main.
3. **Namespace spawning.** Wraps every CLI invocation in `ellul-agent-namespace enter` (or spawn).
4. **Per-project agent (OpenClaw) lifecycle.** Spawn daemons per project, reap on cleanup.
5. **MCP relay.** Spawned subprocess on port 7702, accessible from project namespaces.
6. **Chat persistence.** SQLite chat threads at `/etc/ellul/agent-bridge/chat.db`.

## Architecture

Effect-based runtime. Initialization in `src/main.ts`:

```typescript
async function main() {
  const runtime = await makeApplicationRuntime();
  
  // Internal HTTP RPC: bridge ↔ shield, file-api
  await internalHttp.start(runtime);
  
  // WebSocket RPC server
  await startWsRpcServer(runtime);
  
  // Background:
  await zeroclawAgent.start();          // per-project daemon reconciliation
  await namespaceLifecycle.start();      // pre-warm namespaces every 30s
  await integrationLoader.load();        // MCP servers, secrets, adapters
  await mcpEndpoint.start();             // MCP relay subprocess
  await zenModels.refresh();             // periodic model list
}
```

## Session types

| Type | Description |
| --- | --- |
| `opencode` | API/SSE mode — external provider streaming |
| `claude` | Claude CLI in tmux |
| `codex` | OpenAI Codex CLI in tmux |
| `gemini` | Google Gemini CLI in tmux |
| `main` | Pure shell, no AI |

Per-thread isolation via per-thread $HOME (`~/.ellul/threads/<threadId>/`).

## Namespace integration

Every CLI invocation goes through `namespace-spawn.service.ts`:

```typescript
const cmd = await namespaceSpawn.run(project, {
  envFile: '/tmp/.ns-env-' + uuid(),
  threadId,
  cmd: 'claude --print "Hello"'
});
```

This:

1. Verifies namespace is set up (`isNamespaceRunning(project)`).
2. Writes env vars to a temp file (mode 0600, owned `dev`).
3. Sudo-invokes `ellul-agent-namespace enter --env-file ... --thread-id ... --cmd-file ...`.
4. CLI runs inside the namespace. Output streams back via stdin/stdout pipes.
5. Cleanup: env file deleted; cmd file deleted.

For namespace details: [../isolation/01-namespace-script.md](../isolation/01-namespace-script.md).

## MCP relay

Spawned as subprocess (separate binary, not inlined). Listens on port 7702, bound `0.0.0.0`.

Reachable from project namespace veths only (iptables `ELLUL-NS-IN` chain matches `-i ea-+` interface).

Per-project HMAC token authentication: each project's namespace has a unique token derived from HMAC(jwt-secret, projectSlug). MCP relay validates the token before processing.

For port reachability: [../networking/07-port-registry.md](../networking/07-port-registry.md).

## Chat persistence

`/etc/ellul/agent-bridge/chat.db` (SQLite) holds:

- `threads` — chat thread metadata.
- `messages` — per-thread message history.
- `sessions` — active CLI sessions per thread.
- `orchestration_state` — agent reactor state.

Vault-bound (LUKS-protected). Survives hibernation.

## PoP for chat WebSocket

For `web_locked` tier, agent-bridge enforces PoP signing on the chat WebSocket. Same mechanism as Shield:

- Server issues random 16-byte challenges every 5 minutes.
- Browser signs with non-extractable ECDSA P-256 key.
- 2 consecutive failures terminate connection.

For details: [../security/04-passkey-and-pop.md](../security/04-passkey-and-pop.md).

## Service unit

```ini
[Unit]
After=ellul-sovereign-shield.service
Wants=ellul-luks-boot.service
RequiresMountsFor=/etc/ellul /opt/ellul

[Service]
User=dev
Group=dev
SupplementaryGroups=shield-ipc
EnvironmentFile=/etc/ellul/heap-caps/agentBridge.env
Environment=PORT=7700
ExecStart=/home/dev/.node/bin/node /usr/local/bin/ellul-agent-bridge
Restart=on-failure
ProtectSystem=strict
PrivateTmp=true
LimitCORE=0
ProtectKernelTunables=true
ProtectKernelModules=true
# NoNewPrivileges NOT set — needs sudo for ellul-agent-namespace
```

## Cross-references

- Namespace spawning: [../isolation/01-namespace-script.md](../isolation/01-namespace-script.md).
- Cross-project enforcement: [../security/08-cross-project-isolation.md](../security/08-cross-project-isolation.md).
- Watchdog interactive auth: [02-watchdog.md](./02-watchdog.md).
