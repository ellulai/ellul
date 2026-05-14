# Shield Architecture — Decision Records

> Architecture decisions for the ellul.ai Shield local governance daemon.

## ADR-001: Unix Domain Socket as Primary IPC

**Decision**: Daemon listens on `~/.ellul/daemon.sock` instead of localhost TCP.

**Context**: The daemon must distinguish between same-user callers (MCP subprocess) and other processes. TCP on localhost is reachable by any local process. A bearer token in a file is readable by any same-user process.

**Choice**: Unix domain sockets provide kernel-enforced filesystem permissions. The `~/.ellul/` directory is mode `0700` — only the owning user can traverse it. Additionally, `SO_PEERCRED` (Linux) and `LOCAL_PEERCRED` (macOS) provide per-connection UID/PID verification.

**Consequence**: Requires N-API native addon or C helper binary for peer credential retrieval (Node.js has no built-in API). Falls back to filesystem-only on platforms where neither is available.

## ADR-002: Per-Request Redaction Engine Instances

**Decision**: Each exec request creates a fresh `StreamingRedactionEngine` instance.

**Context**: The Aho-Corasick DFA engine maintains stateful carryover buffers for chunk-boundary detection. A single shared instance across concurrent exec requests would corrupt state.

**Choice**: Store the secret entries list in `cachedSecretEntries`. Each exec constructs a new engine from this list. The DFA compilation cost is paid per-request but is typically <1ms for <100 secrets.

**Consequence**: No shared mutable state across requests. Memory usage is proportional to concurrent exec count.

## ADR-003: Capability-Based Execution Model

**Decision**: Default to a small allowlist of safe commands (test, build, lint, dev). Arbitrary exec requires explicit double-gate opt-in.

**Context**: The agent should be able to run useful commands without being able to execute arbitrary shell operations. The VPS tier provides kernel namespace isolation; the local tier does not.

**Choice**: Pattern-match commands against known safe prefixes (e.g., `npm test`, `go build`, `eslint`). Map each to a specific gate type. Unrestricted mode requires BOTH `config.json` setting AND `ELLUL_ALLOW_UNRESTRICTED=1` environment variable.

**Consequence**: The default experience is constrained but safe. Power users can opt in with full awareness.

## ADR-004: Domain-Separated Operator Signatures

**Decision**: Each privileged operation type uses a distinct signing domain prefix.

**Context**: A single signature format for all operations would allow cross-operation replay — an attacker capturing a gate-approve signature could replay it as a rule-approve.

**Choice**: 9 distinct domain prefixes: `gate-approve|`, `gate-deny|`, `rule-approve|`, `rule-deny|`, `rule-create|`, `rule-toggle|`, `rule-delete|`, `policy-set|`, `secret-reveal|`. Each signature includes a 30-second timestamp tolerance.

**Consequence**: Signatures are bound to their exact operation type, target, and time window.

## ADR-005: Integrity Restoration, Not Prevention

**Decision**: Pre-scan checksum verification restores tampered rules from SQLite, but cannot prevent TOCTOU attacks.

**Context**: The guardrail binary reads `.scm` files from `~/.ellul/guardrails/`. A same-user process can write to this directory. We checksum all files before scanning and restore from SQLite on mismatch.

**Choice**: Acknowledge the TOCTOU window (milliseconds between verify and scan). Log tampering events. Count frequency (>=3 in 5 min triggers elevated warning). The paid tier eliminates this by running the scanner as a different user.

**Consequence**: Honest about what local-tier security provides. Catches and repairs tampering without overclaiming prevention.

## ADR-006: No Secret Export Path

**Decision**: No endpoint, command, or API returns secret values in plaintext over any IPC channel.

**Context**: Secrets exist in the daemon for two purposes: redaction patterns and exec environment injection. Returning them via HTTP or stdout would break credential confinement.

**Choice**: Secrets leave daemon memory only as: (a) Aho-Corasick DFA patterns, (b) child process environment variables, (c) operator-signed `reveal` to REPL stderr. No `GET /secrets/values`, no `export` command.

**Consequence**: Users work productively because secrets are auto-injected into exec. No manual export needed.

## ADR-007: Tamper-Evident Audit Log

**Decision**: Security events are logged to a separate hash-chained audit file.

**Context**: The general daemon log mixes debug output with security events. Security events need post-hoc integrity verification.

**Choice**: Each audit entry includes `SHA-256(prevHash + JSON(entry))`. The chain can be verified offline. Separate from the general structured log.

**Consequence**: Tampering with historical entries is detectable (breaks hash chain). Does NOT prevent a same-user process from rewriting the file — the chain detects, not prevents.

## ADR-008: Graceful Degradation

**Decision**: If SQLite initialization fails, the daemon starts in degraded mode rather than crashing.

**Context**: A corrupt `rules.db` should not prevent the daemon from starting. The gate system and basic request handling can still function.

**Choice**: `ruleStore` is typed as `LocalRuleStore | null`. All route handlers null-check it. Guardrail routes return 503. Exec pipeline fails-closed (scan returns blocked). Gates and secrets still work.

**Consequence**: The daemon is maximally available. The developer gets a clear error about what's degraded instead of a crash.

## Threat Model Summary

| Threat | Free Tier Response | Residual Risk |
|--------|-------------------|---------------|
| Agent via MCP | Fully governed (gates, guardrails, redaction) | None |
| Same-user with file access | Operator signature required for privileged ops | Socket connectable, daemon token not needed (UDS) |
| Same-user with ptrace | Not defended | Paid tier: ptrace_scope=1, separate user |
| Root | Not defended | Paid tier: LUKS, kernel namespaces |
| Supply chain (agent in daemon process) | Not defended | Fundamental trust assumption |
