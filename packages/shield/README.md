# @ellul.ai/shield

Local AI agent governance daemon. Provides credential confinement, streaming redaction, operator approval separation, capability-based execution, and pre-execution AST guardrails — all running on your machine with no cloud backend required.

## Quick Start

```bash
# Initialize a project
cd my-project
ellul-local init my-api

# Start the daemon
ellul-local

# In another terminal, your AI agent uses the MCP tools automatically
# (configured via .mcp.json created during init)
```

## What It Does

When an AI agent (Claude Code, Cursor, Codex) runs on your machine, `shield` sits between the agent and your system:

- **Credential confinement** — agent never holds your API keys, tokens, or secrets. The daemon injects them.
- **Response redaction** — secrets are stripped from command output before the agent sees them.
- **Operator approval** — the agent can't approve its own privileged actions. You approve in the REPL.
- **AST guardrails** — code is scanned by tree-sitter before execution. `DROP TABLE` in a string literal? Blocked.
- **Capability model** — only test/build/lint/dev commands run by default. Arbitrary exec is opt-in.

## Architecture

```
AI Agent ↔ stdio ↔ ellul-mcp-local ↔ Unix socket ↔ ellul daemon
                    (stateless)         (UDS)        (trusted)
                                                        ↓
                                                  guardrail binary
                                                  (tree-sitter AST)
```

The daemon is the last trusted process before the untrusted agent. It holds:
- Operator signing key (SLH-DSA, volatile RAM)
- Secret encryption key (HKDF-derived, volatile RAM)  
- Redaction engine (Aho-Corasick DFA, volatile RAM)

## Commands

```
ellul-local                     Start daemon with interactive REPL
ellul-local init [name]         Initialize project in current directory
ellul-local status              Show daemon and project status
ellul-local stop                Stop running daemon
ellul-local doctor              Run health diagnostics
ellul-local secrets set <n> <v> Store encrypted secret
ellul-local secrets list        List secret names
ellul-local secrets import <f>  Import from .env file
ellul-local gates status        Show gate states
ellul-local rules list          List guardrail rules
ellul-local rules proposals     List pending agent proposals
ellul-local scan                Run guardrail scan
ellul-local env                 Print socket path for eval
```

## REPL Commands

Inside the running daemon:

```
/status              Daemon + project info
/approve <gate>      Approve gate (operator-signed)
/deny <gate>         Deny gate
/secrets list        List secrets
/secrets reveal <n>  Show one secret (operator-signed, stderr)
/rules               List guardrail rules  
/rules proposals     List pending proposals
/rules approve <id>  Approve proposal
/scan                Manual guardrail scan
/help                All commands
1-4                  Quick gate approval when prompted
```

## MCP Tools

Agents access these via the MCP protocol (configured in `.mcp.json`):

| Tool | Description |
|------|-------------|
| `ellul_exec` | Run command with guardrail + gate protection |
| `ellul_list_guardrails` | List active AST rules |
| `ellul_propose_rule_change` | Propose rule modification |
| `ellul_gate_request` | Request gate opening |
| `ellul_gate_status` | Check gate states |
| `ellul_env_read` | List secret names |
| `ellul_env_import` | Import .env content |
| `ellul_scan` | Manual scan |

## Security Model

| Property | Mechanism |
|----------|-----------|
| Agent can't hold secrets | Daemon injects into exec env vars, redacts from output |
| Agent can't self-approve | Operator SLH-DSA key in daemon RAM (separate process) |
| Agent can't bypass guardrails | Fail-closed scanner, 3-strike halt |
| Agent can't tamper with rules | Integrity restoration from SQLite source of truth |
| Agent can't spoof project | STS tokens with workspace fingerprint binding |

**Honest limitations**: Same-user process CAN connect to the daemon socket. Privileged operations still require operator signature. Root compromise = game over. See [docs/v2/products/09-shield-local-daemon/02-architecture.md](../../docs/v2/products/09-shield-local-daemon/02-architecture.md) for the full threat model.

## Package Structure

```
src/
  local/                 Free tier — local daemon
    daemon/              Core daemon, route handlers, REPL
    crypto/              Master secret, HKDF, STS tokens, signatures
    secrets/             AES-256-GCM encrypted SQLite
    gates/               Gate manager, capability allowlist
    guardrails/          Rule store, scanner, strikes
    mcp/                 MCP adapter
    commands/            CLI entry point + subcommands
    infra/               Logger, audit, config, peercred
  cloud/                 Paid tier — VPS-connected
  shared/                Both tiers (content hash, env parser)
native/                  C code (peercred N-API addon)
```

## License

MIT
