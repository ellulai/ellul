# Code-Mode: Batched TypeScript Execution for MCP Tools

## Problem

Each MCP tool call requires a full LLM round trip that re-reads the entire conversation context. Multi-step operations cost 50-76% more tokens than necessary.

| Task size | Individual calls | Code-mode | Savings |
|---|---|---|---|
| Small (6 ops) | ~28K input tok | ~14K | ~50% |
| Medium (15 ops) | ~180K input tok | ~60K | ~67% |
| Large (30 ops) | ~750K input tok | ~180K | ~76% |

## Solution

One tool: `execute_code`. Agent writes TypeScript. One execution boundary. N tool calls batched. One round trip.

```typescript
const users = await secureExecute("db_query", { sql: "SELECT * FROM users WHERE active" });
const report = users.rows.map(u => `${u.name}: ${u.email}`).join("\n");
await secureExecute("file_write", { path: "active-users.txt", content: report });
return { userCount: users.rows.length };
```

Batch variant for independent calls:

```typescript
const batch = await secureExecuteBatch([
  { tool: "db_query", args: { sql: "SELECT * FROM users" } },
  { tool: "file_read", args: { path: "config.json" } },
]);
const [users, config] = batch.results;
// batch.denied lists any calls that were denied with reasons
```

Bash (`exec` gate) is unchanged. Agent picks whichever mode fits.

---

## Architecture

```
secureExecute("db_query", { sql: "..." })
  │
  ├─ Lifecycle check (budget + alive?)
  ├─ ToolResolver.resolve(toolName, args, context) → ToolInvocation
  │    ├─ registry lookup (identity)
  │    ├─ policy check (gate)
  │    └─ idempotency key derivation
  ├─ ToolExecutor.dispatch(invocation)
  └─ Result back to V8 isolate
```

### Core Principles

**Single tool invocation surface.** `secureExecute()` and `secureExecuteBatch()` are the ONLY tool invocation functions exposed inside the V8 isolate. No `tools.*` proxy. No dynamic property access. Note: these are the only *tool invocation* surfaces, not the only host interaction — console bridges also cross the boundary but cannot invoke tools.

**Plane separation.** Policy (decisioning), registry (identity), runtime (execution), lifecycle (state) are logically separated. They scale on different axes: runtime on performance, policy on correctness, orchestration on complexity.

**Lifecycle v1 is ephemeral.** `ExecutionLifecycle` is an in-memory projection. No journal, no event sourcing, no crash recovery. Explicitly marked as ephemeral so v2 migration to durable state is a known-scope change, not a surprise refactor.

**Monotonic call counting.** `getCallCount()` is monotonic and single-writer enforced — only the orchestrator increments it, inside the `onToolCall` callback which is serialized by `applySyncPromise`. This guarantees idempotency key uniqueness: same executionId + same tool + same sequence number = same key, and sequence numbers never repeat or go backward.

**Sequence number = invocation order, NOT completion order.** The `sequenceNumber` is assigned when a tool call is dispatched, not when it completes. Lifecycle tracks invocation count and completion state independently. This invariant holds under v1 (sequential) and preserves correctness if v2 introduces parallel batch dispatch — invocation order remains deterministic even when completion order is non-deterministic.

---

## Tool Call State Machine

Every tool call within an execution has a canonical state. This is the missing deterministic execution primitive — without it, failure semantics are ambiguous.

```
  PENDING ──→ SENT ──→ SUCCESS
                │          └──→ (terminal)
                │
                ├──→ FAILED (MCP error, tool error)
                │       └──→ (terminal)
                │
                ├──→ TIMEOUT (deadline exceeded while SENT)
                │       └──→ (terminal)
                │
                └──→ UNKNOWN (isolate killed mid-call,
                              network partition, process crash)
                        └──→ (terminal, requires investigation)
```

**Why UNKNOWN matters.** If an isolate is killed while a tool call is in-flight (`SENT` but no response), the call may have:
- Never reached the MCP server (safe to retry)
- Reached the server and succeeded (retry = duplicate side effect)
- Reached the server and partially applied (retry = corruption)

Without UNKNOWN, the system silently assumes SUCCESS or FAILED and corrupts state. With UNKNOWN, the orchestrator knows it cannot determine the outcome and logs accordingly.

```typescript
type ToolCallState = 'PENDING' | 'SENT' | 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'UNKNOWN';

interface ToolCallRecord {
  tool: string;
  sequenceNumber: number;
  state: ToolCallState;
  idempotencyKey: string;
  connectionId: string;
  sentAt?: number;
  completedAt?: number;
  result?: ToolCallResult;
}
```

**Invariant: every tool call has exactly one canonical outcome per execution.** The state machine enforces this — once a call reaches a terminal state, it cannot transition again.

**UNKNOWN recovery policy.** When a tool call enters UNKNOWN:
1. The execution is marked as **failed** (not completed) — the orchestrator does not continue
2. The UNKNOWN call is logged with full context (tool, args, idempotency key, sentAt)
3. No automatic retry — the idempotency key may already be consumed server-side
4. The agent receives `status: 'error'` with a message indicating the specific tool call was indeterminate
5. The agent can retry the entire `execute_code` block — the idempotency key for the UNKNOWN call will be different (new executionId) so there's no dedup collision

UNKNOWN does not silently succeed. It terminates the execution and surfaces the ambiguity to the caller.

---

## ToolResolver (Shared Deterministic Layer)

Identity resolution + policy check + idempotency key derivation live in ONE shared layer, not scattered across orchestrator, executor, and registry.

```typescript
class ToolResolver {
  constructor(
    private registry: ToolRegistry,
    private gateway: McpGateway,
  ) {}

  /**
   * Resolve a tool call into a fully-qualified invocation.
   * Single entry point, but internally delegates to three independent functions
   * that evolve at different rates:
   *   - resolveIdentity() — changes when tool registry changes
   *   - evaluatePolicy() — changes when auth/gate logic changes
   *   - deriveIdempotencyKey() — pure, changes almost never
   */
  async resolve(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
    executionId: string,
    sequenceNumber: number,
  ): Promise<ResolveResult> {
    const identity = this.resolveIdentity(toolName);
    if (!identity) return { resolved: false, reason: 'TOOL_NOT_REGISTERED' };

    const policy = await this.evaluatePolicy(identity, context);
    if (!policy.allowed) return { resolved: false, reason: policy.reason, requiredGate: policy.requiredGate };

    const idempotencyKey = deriveIdempotencyKey(executionId, toolName, sequenceNumber);

    return {
      resolved: true,
      invocation: { identity, args, context, idempotencyKey, sequenceNumber, origin: 'codemode' as const },
    };
  }

  /** Identity resolution. Changes when registry changes. */
  private resolveIdentity(toolName: string): ToolIdentity | null {
    return this.registry.resolve(toolName);
  }

  /** Policy evaluation. Changes when auth/gate logic changes. */
  private async evaluatePolicy(identity: ToolIdentity, context: ToolCallContext): Promise<PolicyResult> {
    const perm = this.gateway.getToolPermission(identity.connectionId, identity.toolName);
    if (perm === 'never') return { allowed: false, reason: 'TOOL_BLOCKED' };
    if (perm === 'allow_always') return { allowed: true };

    const gate = CAPABILITY_GATE[identity.capability];
    const open = await checkGateOpen(gate, context.threadId);
    if (!open) return { allowed: false, reason: 'GATE_CLOSED', requiredGate: gate };

    return { allowed: true };
  }
}

/**
 * Deterministic idempotency key derivation.
 * Pure function. Changes almost never. Shared across:
 * orchestrator, executor, replay engine.
 */
function deriveIdempotencyKey(executionId: string, toolName: string, sequenceNumber: number): string {
  return sha256(`${executionId}:${toolName}:${sequenceNumber}`);
}

type ResolveResult =
  | { resolved: true; invocation: ToolInvocation }
  | { resolved: false; reason: string; requiredGate?: GateType };
```

**One external function, three internal functions.** Orchestrator calls `resolve()`. Internally, identity resolution, policy evaluation, and idempotency derivation are separate functions that can evolve independently. Policy changes don't touch replay logic. Identity changes don't affect idempotency. But consumers get one deterministic entry point.

---

## Batch Execution Primitive

`secureExecuteBatch()` enables parallel gate resolution and request coalescing for independent calls.

```typescript
// Inside the V8 isolate — exposed alongside secureExecute
async function secureExecuteBatch(
  calls: Array<{ tool: string; args: Record<string, unknown> }>
): Promise<{ results: unknown[]; denied: Array<{ index: number; tool: string; reason: string }> }>
```

Even if internally serialized in v1, the batch primitive enables:
- **Preflight permission resolution**: check all gates before dispatching any call
- **Parallel gate checks**: one `checkGateOpen()` per unique gate, not per call
- **Request coalescing**: multiple calls to the same MCP server batched into one JSON-RPC session
- **Partial execution with structured denial report**: allowed calls execute, denied calls return structured denial (NOT all-or-nothing — that kills batch value when 1 of 10 calls needs a different gate)

v1 implementation: iterate sequentially, but through the batch API. v2: parallel dispatch.

```typescript
interface BatchResult {
  results: Array<ToolCallResult | null>;  // null = denied, result = executed
  denied: Array<{ index: number; tool: string; reason: string; requiredGate?: GateType }>;
}

async function handleBatch(
  calls: Array<{ tool: string; args: Record<string, unknown> }>,
  context: ToolCallContext,
  executionId: string,
  baseSequence: number,
): Promise<BatchResult> {
  // Phase 1: Resolve all — split into allowed vs denied
  const allowed: Array<{ index: number; invocation: ToolInvocation }> = [];
  const denied: BatchResult['denied'] = [];

  for (let i = 0; i < calls.length; i++) {
    const result = await this.resolver.resolve(calls[i].tool, calls[i].args, context, executionId, baseSequence + i);
    if (result.resolved) {
      allowed.push({ index: i, invocation: result.invocation });
    } else {
      denied.push({ index: i, tool: calls[i].tool, reason: result.reason, requiredGate: result.requiredGate });
    }
  }

  // Phase 2: Dispatch allowed calls (v1: sequential. v2: parallel.)
  const results: Array<ToolCallResult | null> = new Array(calls.length).fill(null);
  for (const { index, invocation } of allowed) {
    results[index] = await this.executor.dispatch(invocation);
  }

  return { results, denied };
}
```

---

## Components

### ToolRegistry

Pure data. Tool identity is `(name + connectionId + capability)`, not just name.

```typescript
interface ToolIdentity {
  toolName: string;
  connectionId: string;
  capability: ToolCapability;
}

class ToolRegistry {
  private tools = new Map<string, ToolIdentity>();
  sync(governedTools: GovernedToolDefinition[]): void
  resolve(toolName: string): ToolIdentity | null
  has(toolName: string): boolean
}
```

Prevents: MCP namespace collisions, ambiguous routing, privilege escalation via name reuse. Rebuilds on integration reload.

### ToolExecutor

Transport only. Dispatches resolved invocations. No policy. No retry. No identity resolution.

```typescript
class ToolExecutor {
  constructor(private gateway: McpGateway) {}

  async dispatch(invocation: ToolInvocation): Promise<ToolCallResult> {
    return this.gateway.callToolDirect(
      invocation.identity.connectionId,
      invocation.identity.toolName,
      invocation.args,
      invocation.context,
    );
  }
}
```

Retry responsibility: the orchestrator decides whether to retry based on `result.retryable` + idempotency key. The executor never retries — it is a dumb pipe.

### ExecutionRuntime

Stateless. Disposable. No policy. Owns the V8 isolate and `secureExecute`/`secureExecuteBatch` bridges.

```typescript
class ExecutionRuntime {
  async execute(
    code: string,
    typeDefinitions: string,
    config: { timeoutMs: number; memoryLimitMb: number },
    onToolCall: (toolName: string, args: Record<string, unknown>) => Promise<ToolCallResult>,
    onBatchCall: (calls: Array<{ tool: string; args: Record<string, unknown> }>) => Promise<BatchResult>,
    onConsole: (level: string, args: string[]) => void,
  ): Promise<RuntimeResult>
}
```

Hardening: minimal hygiene only. The real security boundary is `isolated-vm` native isolation + kernel namespaces + seccomp. JS-level freezing is cosmetic — do not rely on it for security.

### ExecutionLifecycle

In-memory budget + cancellation tracker. Explicitly ephemeral — does not survive process restart.

```typescript
class ExecutionLifecycle {
  /** Ephemeral projection. Not durable. v2 migrates to journal-backed state. */
  private executions = new Map<string, ExecutionState>();

  create(config: { timeoutMs: number; maxToolCalls: number; memoryLimitMb: number }): string
  cancel(executionId: string): void
  isAlive(executionId: string): boolean
  checkBudget(executionId: string, isolate?: ivm.Isolate): { ok: boolean; reason?: string }
  recordToolCall(executionId: string, record: ToolCallRecord): void
  getCallCount(executionId: string): number
  getToolCalls(executionId: string): ToolCallRecord[]
  complete(executionId: string): void
  fail(executionId: string): void
  cleanup(maxAgeMs?: number): void    // GC for finished executions
}
```

`checkBudget` enforces three limits:
- **Tool call count**: monotonic, single-writer (see Core Principles)
- **Wall-clock deadline**: `Date.now() > createdAt + timeoutMs`
- **Heap memory**: `isolate.getHeapStatisticsSync().used_heap_size > memoryLimitMb * 0.9` — `isolated-vm` exposes heap stats; check on each tool call as an early warning before the hard OOM kill

### Observability

Three events. That's it for v1.

```typescript
interface ObservabilityEmitter {
  emit(event: 'tool.started', data: { tool: string; executionId: string; sequenceNumber: number }): void;
  emit(event: 'tool.finished', data: { tool: string; executionId: string; durationMs: number; state: ToolCallState; idempotencyKey: string }): void;
  emit(event: 'tool.failed', data: { tool: string; executionId: string; error: string; state: ToolCallState; idempotencyKey: string }): void;
}
```

Everything else (trace IDs, event taxonomy, structured streams) evolves from these three when needed. The shape is intentionally compatible with OpenTelemetry spans — `executionId` maps to trace ID, `sequenceNumber` to span ordering, `durationMs` to span duration. Wiring to OTel is a consumer change, not a schema change.

---

## Orchestrator

Thin. Wires planes together. Owns nothing except the execution flow.

```typescript
class CodeModeService {
  constructor(
    private runtime: ExecutionRuntime,
    private resolver: ToolResolver,
    private executor: ToolExecutor,
    private lifecycle: ExecutionLifecycle,
    private emitter: ObservabilityEmitter,
  ) {}

  async executeCode(code: string, context: ToolCallContext, typeDefs: string): Promise<CodeModeResult> {
    const executionId = this.lifecycle.create({ timeoutMs: 30_000, maxToolCalls: 50 });

    try {
      const result = await this.runtime.execute(
        code, typeDefs,
        { timeoutMs: 30_000, memoryLimitMb: 128 },

        // secureExecute callback
        async (toolName, args) => {
          const budget = this.lifecycle.checkBudget(executionId);
          if (!budget.ok) throw new Error(budget.reason);
          if (!this.lifecycle.isAlive(executionId)) throw new Error('Execution cancelled');

          const seq = this.lifecycle.getCallCount(executionId);
          const resolution = await this.resolver.resolve(toolName, args, context, executionId, seq);

          if (!resolution.resolved) {
            return { status: 'approval_required', requiredGate: resolution.requiredGate, reason: resolution.reason };
          }

          const record: ToolCallRecord = {
            tool: toolName, sequenceNumber: seq,
            state: 'SENT', idempotencyKey: resolution.invocation.idempotencyKey,
            sentAt: Date.now(),
          };

          this.emitter.emit('tool.started', { tool: toolName, executionId, sequenceNumber: seq });

          try {
            const result = await this.executor.dispatch(resolution.invocation);
            record.state = result.status === 'success' ? 'SUCCESS' : 'FAILED';
            record.result = result;
            record.completedAt = Date.now();
            this.emitter.emit('tool.finished', {
              tool: toolName, executionId,
              durationMs: record.completedAt - record.sentAt!, state: record.state,
            });
            this.lifecycle.recordToolCall(executionId, record);
            return result;
          } catch (err) {
            record.state = 'UNKNOWN';
            record.completedAt = Date.now();
            this.emitter.emit('tool.failed', {
              tool: toolName, executionId, error: String(err), state: 'UNKNOWN',
            });
            this.lifecycle.recordToolCall(executionId, record);
            throw err;
          }
        },

        // secureExecuteBatch callback
        async (calls) => {
          return this.handleBatch(calls, context, executionId);
        },

        // console callback
        (level, args) => {},
      );

      this.lifecycle.complete(executionId);
      return this.mapResult(result, executionId);
    } catch (err) {
      this.lifecycle.complete(executionId);
      return { status: 'error', error: { message: String(err) }, executionId };
    }
  }
}
```

**Note on physical entanglement.** The orchestrator currently wires runtime + policy + transport in one callback. This is correct for v1 (single-process, sequential). If these systems need to scale independently (runtime → performance, policy → correctness, orchestration → complexity), the callback splits into separate services. The plane separation is logical now, physical later.

---

## Security Model

### Trust hierarchy

```
1. Sovereign Shield gate system     ← ultimate authority (passkey, TTL, fail-closed)
2. ToolResolver policy check        ← all allow/deny decisions
3. Tool Registry                    ← identity resolution
4. Execution Lifecycle              ← resource budgets
─────────── trust boundary ───────────
5. Kernel namespaces + seccomp      ← OS containment (defense-in-depth)
6. isolated-vm V8 isolate           ← process isolation (defense-in-depth)
7. Object.freeze / delete eval      ← hygiene only
```

---

## Coexistence with Bash

```
execute_code  — TypeScript code-mode (batched, typed)
exec          — Bash (shell commands, python, etc.)
```

Both use `exec` gate. Both run under the same security model.

---

## System Prompt Integration

The `context.service.ts` code-mode section includes:

1. **Typed tool signatures** — auto-generated from `type-generator.ts` using the gateway's existing `GovernedToolDefinition` schemas. The LLM sees `secureExecute("db_query", { sql: string, params?: unknown[] })` with full argument types.

2. **Batch partial result guidance** — explicitly tells the LLM: "When using `secureExecuteBatch`, some calls may be denied while others succeed. Handle partial results — check the `denied` array and use the results that succeeded."

3. **Mode selection** — when to use `execute_code` (3+ tool calls, data transformation) vs `exec` (shell, python, single commands).

---

## Result Types

```typescript
interface CodeModeResult {
  status: 'success' | 'error' | 'timeout' | 'cancelled' | 'tool_denied';
  output: unknown;
  console: ConsoleEntry[];
  toolCalls: ToolCallSummary[];
  durationMs: number;
  executionId: string;
  peakMemoryMb: number;
  error?: { message: string; stack?: string };
  deniedTool?: { name: string; gate: string; reason: string };
}

interface ToolCallSummary {
  tool: string;
  sequenceNumber: number;
  state: ToolCallState;
  idempotencyKey: string;    // exposed for agent debugging
  durationMs: number;
  connectionId: string;
}

interface ConsoleEntry {
  level: 'log' | 'warn' | 'error';
  args: string[];
}
```

The `idempotencyKey` is exposed in every `ToolCallSummary` so the agent can log it when debugging tool call failures. If a tool call enters UNKNOWN, the key is the handle for manual investigation.

---

## Gateway Integration

`execute_code` registered as a builtin tool:

- Capability: `execution:code_eval` (types.ts line 99 — exists)
- Gate: `exec` (CAPABILITY_GATE line 205 — exists)
- `callToolDirect()`: new public method exposing existing private `executeToolCall()` — MCP JSON-RPC dispatch only

---

## Implementation

### v1 (build now)

| File | Role | Lines |
|---|---|---|
| `code-mode/tool-resolver.ts` | Identity + policy + idempotency key (single shared layer) | ~120 |
| `code-mode/execution-runtime.ts` | V8 isolate, secureExecute + secureExecuteBatch bridges | ~250 |
| `code-mode/tool-executor.ts` | Transport only. MCP dispatch. No retry. | ~50 |
| `code-mode/tool-registry.ts` | Identity (name + connectionId + capability) | ~80 |
| `code-mode/execution-lifecycle.ts` | Budget, timeout, cancel, tool call records (ephemeral) | ~120 |
| `code-mode/observability.ts` | 3 events: tool.started, tool.finished, tool.failed | ~30 |
| `code-mode/code-mode.service.ts` | Thin orchestrator | ~150 |
| `code-mode/type-generator.ts` | JSON Schema → TypeScript for system prompt | ~200 |
| `code-mode/builtin-tool-registry.ts` | Registers execute_code in gateway | ~100 |
| `mcp-gateway.service.ts` (mod) | Builtin support, callToolDirect() | ~60 |
| `context.service.ts` (mod) | Code-mode prompt section (includes batch partial result guidance) | ~60 |
| `main.ts` (mod) | Startup wiring | ~20 |

Dependency: `isolated-vm` ^6.1.2.

### v2 (only if needed)

| What | Trigger |
|---|---|
| Gate cache (per-execution, positive-only, short TTL) | Gate check latency measurably hurts execution time |
| Structured event log (append-only) | Debugging production failures is hard |
| Idempotency keys as MCP protocol header | Duplicate tool calls observed |
| Durable lifecycle (journal-backed) | Process crashes lose critical execution state |

### v3 (only if scaling breaks)

| What | Trigger |
|---|---|
| Admission controller | Multi-tenant load causes starvation |
| Per-execution cgroup slices | Isolate-level limits insufficient |
| Parallel batch dispatch | Sequential batch is measured bottleneck |

---

## What this is

A batched tool execution layer that collapses N MCP tool calls into 1 execution boundary. Single tool invocation surface (`secureExecute` / `secureExecuteBatch`), identity-based routing, formal tool call state machine with UNKNOWN recovery, shared deterministic resolver, partial-execution batch semantics.

## What this is not

A distributed execution OS. The plane separation is correct architecture for the stated problem. The enterprise extensions (journal, replay, admission, cgroups) are documented and scoped but explicitly deferred until measured need.
