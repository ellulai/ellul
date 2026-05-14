# Changelog

All notable changes to `@ellul.ai/shield` will be documented in this file.

## [0.1.0] — 2026-04-03

### Added

#### Local Governance Daemon
- Unix domain socket IPC with peer credential verification (SO_PEERCRED / LOCAL_PEERCRED)
- N-API native addon + C helper binary fallback for per-connection UID verification
- Master secret stored in OS keychain (macOS Keychain / Linux secret-tool) with HKDF key derivation
- SLH-DSA-SHA2-128s operator keypair (volatile RAM, zeroized on shutdown)
- Local STS tokens with workspace fingerprint binding (SHA-256 of slug + canonical path)
- Per-route body size limits and rate limiting (100 req/s per client)
- Connection draining on graceful shutdown (5s drain window)
- STS token verification on all guarded routes with workspace fingerprint check
- Correlation ID propagation on all responses (X-Correlation-Id header)

#### Credential Confinement
- AES-256-GCM encrypted per-project SQLite secret store
- No secret export path — values injected as exec env vars and loaded into redaction engine only
- Operator-signed secret reveal (secret-reveal domain) to REPL stderr only
- Aho-Corasick DFA streaming response redaction (multi-encoding: raw, base64, URL, hex)
- Per-request redaction engine instances (concurrency-safe, no shared mutable state)

#### Execution Governance
- Capability-based command model (test/build/lint/dev) with explicit unrestricted opt-in
- SSE streaming exec pipeline with real-time output redaction
- 9-step exec pipeline: capability check → gate check → proposal ingestion → strike check → integrity restoration → guardrail scan → exec → redaction → response
- Time-bounded gate approvals with operator SLH-DSA signatures
- 9 domain-separated signature types prevent cross-operation reuse

#### AST Guardrails
- Tree-sitter static analysis (Go, Python, JavaScript, TypeScript, Rust)
- Empty Vessel scanner — zero hardcoded policy, all rules from SQLite
- 3 locked default rules: no-drop-table, no-drop-database, no-recursive-delete
- Human-in-the-loop rule proposal workflow (agent proposes → human approves)
- Pre-scan integrity restoration with SHA-256 checksums against SQLite source of truth
- 3-strike token burn protection (30-min auto-expire)
- Fail-closed on all scanner failures

#### CLI
- `ellul-local` entry point with subcommand routing
- `init`, `status`, `stop`, `doctor`, `secrets`, `gates`, `rules`, `scan`, `rebind`, `env` commands
- Interactive REPL with gate approval flow, readline history, terminal resize handling
- 9-check health diagnostics (`ellul-local doctor`)

#### MCP Adapter
- `ellul-mcp-local` stdio MCP server for Claude Code, Cursor, Codex, Gemini
- 8 tools: exec, list_guardrails, propose_rule_change, gate_request, gate_status, env_read, env_import, scan
- SSE streaming consumption for exec output
- Retry with exponential backoff on daemon connection failures

#### Observability
- Structured JSON logging with 10MB file rotation (keep 3)
- Tamper-evident audit log with SHA-256 hash chaining
- Secret scrubbing in all log output
- Strict config schema validation at startup

### Security Notes
- Free tier protects against untrusted AI agents operating through the MCP interface
- Does NOT protect against same-user process reading daemon memory (ptrace)
- Root compromise is explicitly out of scope (paid tier boundary)
- Agent ignorance of paths/tokens is NOT claimed as security — operator key separation is the boundary
