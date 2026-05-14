# Headless Trust Infrastructure API — Technical Specification v1

## Table of Contents

- [0. Terminology & Trust Boundaries](#0-terminology--trust-boundaries)
- [1. Host & Workspace Lifecycle API (`/v1/hosts`, `/v1/workspaces`)](#1-host--workspace-lifecycle-api-v1hosts-v1workspaces)
- [2. Zero-Knowledge Secret Provisioning (`/v1/secrets`)](#2-zero-knowledge-secret-provisioning-v1secrets)
- [3. Asynchronous Gate Flow (The "Pause" Pipeline)](#3-asynchronous-gate-flow-the-pause-pipeline)
- [4. Audit & Provability (`/v1/audit`)](#4-audit--provability-v1audit)
- [5. Full Integration Timeline](#5-full-integration-timeline)
- [6. Webhook Security & Reliability](#6-webhook-security--reliability)
- [7. Error Taxonomy](#7-error-taxonomy)
- [8. Hardware Attestation (`/v1/attestation`)](#8-hardware-attestation-v1attestation)

---

## 0. Terminology & Trust Boundaries

### Two-Level Architecture: Host → Workspaces

A single Shield Host runs one Sovereign Shield proxy that serves **many workspaces for a single tenant (organization)**. Each workspace runs in its own Linux namespace with independent secrets, gates, passkeys, and audit chains. The host provides shared infrastructure (RSA keypair, TPM, proxy endpoint); workspaces provide per-employee isolation within the organization.

**1 Tenant = 1 Kernel.** Different organizations always run on different hardware. A kernel breakout within a tenant's host is an internal insider threat (Employee A accessing Employee B's workspace), not a cross-company data breach. This matches the CISO risk model: intra-org incidents are accepted corporate risk; cross-org incidents are existential liability.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         TRUST BOUNDARY MAP                               │
│                                                                          │
│  ┌───────────────┐    ┌──────────────────┐    ┌───────────────────────┐  │
│  │ 3rd-Party      │    │ Ellul.ai Control │    │ Shield Host (VPS)     │  │
│  │ Platform       │    │ Plane            │    │                       │  │
│  │                │    │                  │    │ BOUND TO: 1 Tenant    │  │
│  │ UNTRUSTED for  │    │ ORCHESTRATOR     │    │ (e.g., "acme_corp")   │  │
│  │ secrets. Sees  │    │ Never sees       │    │                       │  │
│  │ ciphertext     │    │ plaintext        │    │ One Sovereign Shield  │  │
│  │ only.          │    │ secrets.         │    │ One RSA-4096 keypair  │  │
│  │                │    │ Routes, bills,   │    │ One SQLite DB         │  │
│  │                │    │ provisions.      │    │                       │  │
│  └───────┬───────┘    └────────┬─────────┘    │ ┌──────┐ ┌──────┐    │  │
│          │                     │              │ │ WS-A │ │ WS-B │    │  │
│          │  API Key auth       │  Signed      │ │emp_1 │ │emp_2 │ …  │  │
│          │  (server-to-server) │  commands     │ │secrt │ │secrt │    │  │
│          ├────────────────────>│─────────────>│ │gates │ │gates │    │  │
│          │                     │              │ │audit │ │audit │    │  │
│          │                     │              │ └──────┘ └──────┘    │  │
│          │                     │              │                       │  │
│          │                     │              │ All workspaces belong  │  │
│          │                     │              │ to the SAME tenant.    │  │
│          │                     │              │ Different tenants get  │  │
│          │                     │              │ different hosts        │  │
│          │                     │              │ (different kernels).   │  │
│          │                     │              │                       │  │
│          │                     │              │ Each workspace:       │  │
│          │                     │              │  • Own end-user        │  │
│          │                     │              │  • Own passkey         │  │
│          │                     │              │  • Own namespace       │  │
│          │                     │              │  • Own secrets         │  │
│          │                     │              │  • Own gates           │  │
│          │                     │              │  • Own audit chain     │  │
│          │                     │              │  • Own network policy  │  │
│          │                     │              └───────────┬───────────┘  │
│          │                                                │              │
│  ┌───────────────┐                                        │              │
│  │ End-User       │  Passkey ceremonies go DIRECTLY        │              │
│  │ (Employee)     │  to Shield Host, scoped to their      │              │
│  │                │  workspace's credential.               │              │
│  │ SOVEREIGN      ├──────────────────────────────────────>│              │
│  │ AUTHORITY      │                                        │              │
│  └───────────────┘                                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

| Term | Definition |
|---|---|
| **Platform** | The 3rd-party B2B customer (an AI agent orchestrator, coding assistant, etc.) |
| **Tenant** | An organization (company, team, department) that owns a host. All workspaces on a host belong to the same tenant. Different tenants always get different kernels. |
| **End-User** | An individual within the tenant (an employee, contractor, or agent operator) who owns secrets and holds a passkey for their workspace. |
| **Host** | A VPS running one Sovereign Shield proxy instance, **cryptographically bound to a single `tenant_id`**. Serves multiple workspaces for that tenant's end-users. Provisioned once (slow, minutes). Shared RSA keypair, TPM, proxy endpoint. The host will physically reject workspaces belonging to any other tenant. |
| **Workspace** | An isolated execution namespace on a host, bound to a single `end_user_id` within the tenant. Created fast (seconds). Has its own passkey, secrets, gates, network policy, and audit chain. |
| **Gate** | A policy-defined operation type requiring human PoP before the proxy will act |
| **PoP** | Proof-of-Possession — a WebAuthn assertion proving the end-user's physical authenticator signed a challenge |
| **Envelope** | An RSA-4096 encrypted payload containing a secret, decryptable only by the host's Shield proxy private key |

---

## 1. Host & Workspace Lifecycle API (`/v1/hosts`, `/v1/workspaces`)

### 1.1 Provision a Host

Hosts are the slow infrastructure layer — one host per tenant (organization). A platform provisions a host for each of its customer organizations, then creates many workspaces (one per employee/agent) on that host.

```http
POST /v1/hosts
Authorization: Bearer sk_live_...
Idempotency-Key: idk_host_001
Content-Type: application/json
```

```json
{
  "tenant_id": "acme_corp",
  "region": "eu-central-1",
  "workspace_limit": 50,
  "tier": "standard"
}
```

The `tenant_id` field is **mandatory and immutable**. Once a host boots, it is cryptographically bound to this single tenant (organization). The Shield proxy writes the `tenant_id` into its local identity file at first boot (`/etc/ellul/shield-data/bound-tenant-id`, root-owned, immutable) and will reject any workspace creation request belonging to a different tenant. This is the **1 Tenant = 1 Kernel** invariant — different organizations are physically guaranteed to run on different hardware.

Within the tenant, multiple end-users (employees) can have workspaces on the same host. A kernel breakout would be an intra-org incident (insider threat), not a cross-company breach.

#### Response

```http
HTTP/1.1 201 Created
```

```json
{
  "host_id": "host_Qm3xR7",
  "status": "provisioning",
  "region": "eu-central-1",
  "tenant_id": "acme_corp",
  "workspace_limit": 50,
  "workspace_count": 0,

  "proxy": {
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\nMIICIjANBgkqh...\n-----END PUBLIC KEY-----",
    "public_key_fingerprint": "SHA256:a3f9b2c1d4e5...",
    "endpoint": "https://shield-eu-qm3x.ellul.ai"
  },

  "created_at": "2026-03-30T12:00:00Z"
}
```

#### Host State Machine

```
provisioning → ready → degraded → destroying → destroyed
                 ↑        │
                 └────────┘  (health restored)
```

- `ready → degraded`: health check failure
- `degraded → ready`: health restored
- `ready|degraded → destroying`: DELETE request (only if workspace_count == 0)
- Hosts with 0 workspaces for >1 hour auto-hibernate (cost optimization)

### 1.2 Create a Workspace on a Host

Workspace creation is fast (seconds) — it creates a Linux namespace on an existing host. No VPS provisioning required. Each workspace is bound to a specific end-user (employee) within the tenant's organization.

```http
POST /v1/hosts/host_Qm3xR7/workspaces
Authorization: Bearer sk_live_...
Idempotency-Key: idk_ws_abc123
Content-Type: application/json
```

```json
{
  "end_user_id": "employee_1",

  "sandbox": {
    "runtime": "namespace",
    "resources": {
      "cpu_cores": 2,
      "memory_mb": 4096,
      "disk_mb": 10240,
      "max_duration_seconds": 3600
    }
  },

  "network_policy": {
    "egress_allow": [
      { "host": "api.openai.com",    "port": 443, "protocol": "tcp" },
      { "host": "registry.npmjs.org", "port": 443, "protocol": "tcp" },
      { "host": "*.solana.com",       "port": 443, "protocol": "tcp" }
    ],
    "egress_deny_all_other": true,
    "dns_policy": "proxy_only"
  },

  "gate_policy": {
    "gates": [
      {
        "type": "wallet_spend",
        "constraints": {
          "chain": "solana",
          "max_per_tx_lamports": 1000000000,
          "max_session_lamports": 5000000000,
          "allowed_programs": ["11111111111111111111111111111111"]
        }
      },
      {
        "type": "secret_read",
        "constraints": {
          "allowed_keys": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
          "inject_as": "header"
        }
      },
      {
        "type": "db_write",
        "constraints": {
          "max_rows_affected": 100,
          "blocked_statements": ["DROP", "TRUNCATE", "ALTER"]
        }
      }
    ],
    "default_ttl_seconds": 300,
    "auto_deny_on_timeout": true
  },

  "callbacks": {
    "webhook_url": "https://platform.example.com/webhooks/ellul",
    "webhook_secret": "whsec_...",
    "sse_enabled": true
  }
}
```

#### Response

```http
HTTP/1.1 201 Created
```

```json
{
  "workspace_id": "ws_7kX2mP9q",
  "host_id": "host_Qm3xR7",
  "status": "awaiting_registration",
  "region": "eu-central-1",

  "proxy": {
    "public_key_pem": "-----BEGIN PUBLIC KEY-----\nMIICIjANBgkqh...\n-----END PUBLIC KEY-----",
    "public_key_fingerprint": "SHA256:a3f9b2c1d4e5...",
    "endpoint": "https://shield-eu-qm3x.ellul.ai"
  },

  "passkey": {
    "registration_url": "https://shield-eu-qm3x.ellul.ai/ceremony/register?ws=ws_7kX2mP9q&t=eyJ...",
    "registration_expires_at": "2026-03-30T12:30:00Z"
  },

  "sse_url": "https://api.ellul.ai/v1/workspaces/ws_7kX2mP9q/events",

  "created_at": "2026-03-30T12:00:05Z"
}
```

The `proxy` fields are inherited from the host — all workspaces on the same host share the same proxy endpoint and RSA public key. Each workspace gets its own passkey registration URL scoped to its workspace ID.

> **Tenant enforcement**: The workspace's tenant (inherited from the host) is verified at both the control plane and Shield proxy level. The Shield proxy independently checks that every workspace creation request arrives from a command signed for its bound `tenant_id` — even if the control plane were compromised, the proxy would reject workspaces from a different organization.

### 1.3 Create a Workspace (Auto-Host Convenience)

For platforms that don't want to manage hosts explicitly, this endpoint auto-selects or provisions a host:

```http
POST /v1/workspaces
Authorization: Bearer sk_live_...
Content-Type: application/json
```

```json
{
  "tenant_id": "acme_corp",
  "end_user_id": "employee_1",
  "region": "eu-central-1",
  "sandbox": { "..." },
  "network_policy": { "..." },
  "gate_policy": { "..." },
  "callbacks": { "..." }
}
```

The control plane:
1. Finds an existing host in the requested region **bound to this exact `tenant_id`** with `status: ready` and available capacity
2. If found: creates workspace on that tenant's host (fast — seconds)
3. If not found: provisions a new dedicated host **for this `tenant_id`** (slow — minutes), then creates workspace

> **1 Tenant = 1 Kernel**: The auto-host logic will **never** place two different tenants on the same host. If a platform sends workspaces for `acme_corp` and `globex_inc`, they will always land on separate VPSes with separate kernels. This is structurally enforced — the host's `tenant_id` is immutable and checked on every workspace creation. Multiple employees within the same tenant share a host — that is the accepted intra-org risk model.

The response is identical to section 1.2. The `host_id` field tells the platform which host was selected.

### 1.4 Network Policy Enforcement

The `network_policy` maps directly to nftables rules injected into the workspace's namespace:

```bash
# Generated by Shield proxy for workspace ws_7kX2mP9q
# Namespace: ht-ws7kx2mp (workspace-scoped, isolated from other workspaces)

# Default: drop all egress inside this namespace
nft add rule inet filter output drop

# Allow DNS only to proxy's internal resolver
nft add rule inet filter output ip daddr 10.200.x.1 udp dport 53 accept

# Allow egress to proxy's internal listener (all gated traffic routes here)
nft add rule inet filter output ip daddr 10.200.x.1 tcp dport 8443 accept

# Proxy-level enforcement (application layer):
# - TLS SNI inspection against egress_allow list
# - Reject connections to non-allowlisted hosts with 403
# - Log all connection attempts to audit ledger
```

Each workspace gets its own veth pair with a deterministic subnet (`10.200.{port%256}.{1,2}/30`). The proxy does **TLS SNI inspection**, not just IP-based filtering, preventing DNS rebinding attacks.

### 1.5 Workspace State Machine

```
                POST /v1/hosts/{id}/workspaces
                  (or POST /v1/workspaces)
                           │
                           ▼
                    ┌──────────────┐
                    │ creating     │  ← Namespace creation (seconds)
                    └──────┬───────┘
                           │ Namespace ready, nftables applied
                           ▼
                    ┌──────────────┐    No passkey registration
                    │ awaiting_    │───── within TTL ──────────┐
                    │ registration │                           │
                    └──────┬───────┘                           │
                           │ Passkey registered                │
                           ▼                                   │
                    ┌──────────────┐                           │
                    │ ready        │                           │
                    └──────┬───────┘                           │
                           │ POST .../execute                  │
                           ▼                                   │
                    ┌──────────────┐                           │
                    │ running      │◄─── gate.resolved ───┐   │
                    └──┬───┬───┬───┘                      │   │
                       │   │   │                          │   │
          Agent exits  │   │   │ Agent hits gate          │   │
          normally     │   │   └──────────────────┐       │   │
                       │   │                      ▼       │   │
                       │   │               ┌────────────┐ │   │
                       │   │               │ paused     ├─┘   │
                       │   │               └─────┬──────┘     │
                       │   │                     │            │
                       │   │          Gate denied / timeout   │
                       │   │                     │            │
                       │   │                     ▼            │
                       │   │  max_duration  ┌──────────┐      │
                       │   └───────────────>│ terminated│<─────┘
                       │                    └──────────┘
                       ▼                         │
                 ┌───────────┐                   │
                 │ completed │                   │
                 └───────────┘                   │
                       │                         │
                       ▼                         ▼
                 ┌─────────────────────────────────┐
                 │ archived (logs + ledger frozen)  │
                 └─────────────────────────────────┘
```

Note: `creating` replaces `provisioning` from earlier drafts. Namespace creation takes seconds (not minutes), since the host is already running.

### 1.6 Execute a Workload

```http
POST /v1/workspaces/ws_7kX2mP9q/execute
Authorization: Bearer sk_live_...
```

```json
{
  "command": ["node", "agent.js", "--task", "deploy-contract"],
  "working_directory": "/workspace",
  "env": {
    "TASK_ID": "task_123",
    "SHIELD_PROXY": "http://10.200.x.1:8443"
  },
  "stdin_payload_b64": null
}
```

> **Note:** `env` contains only non-sensitive configuration. Secrets are provisioned separately via `/v1/secrets` and are never placed in environment variables. `SHIELD_PROXY` points to the host-side veth IP for this workspace's namespace.

### 1.7 Additional Endpoints

```
# Host management
GET    /v1/hosts                         # List all hosts for this API key
GET    /v1/hosts/{id}                    # Host status, workspace count, capacity
DELETE /v1/hosts/{id}                    # Tear down (only if workspace_count == 0)

# Workspace management
GET    /v1/hosts/{id}/workspaces         # List workspaces on a host
GET    /v1/workspaces/{id}               # Status, resource usage, active gates
DELETE /v1/workspaces/{id}               # Tear down workspace (destroy namespace, zero secrets)
GET    /v1/workspaces/{id}/logs          # Agent stdout/stderr (streamed or paginated)
```

### 1.8 Multi-Workspace Isolation Guarantees

Multiple workspaces on the same host are isolated at multiple layers:

| Layer | Mechanism | What It Prevents |
|---|---|---|
| **Network** | Separate network namespace per workspace (veth pair + nftables) | Workspace A cannot see workspace B's traffic |
| **Filesystem** | Private tmpfs mounts per namespace (/data, /tmp, .cache) | Workspace A cannot read workspace B's files |
| **Process** | PID namespace isolation | Workspace A cannot see workspace B's processes |
| **Secrets** | Per-workspace envelope directory (`/envelopes/{ws_slug}/`) with root:shield 640 | Workspace A's secrets are inaccessible from workspace B |
| **Gates** | Per-workspace gate scoping (`app:{ws_slug}:{gate}`) | Workspace A's gate approval cannot unlock workspace B |
| **Passkeys** | Per-workspace WebAuthn credential binding | Workspace A's passkey cannot approve workspace B's operations |
| **Audit** | Per-workspace hash chain (independent sequence counters) | Workspace A's audit trail is cryptographically separate |
| **Database** | Per-workspace PostgreSQL roles (`shield_{ws_slug}_app`) | Workspace A cannot query workspace B's database |

---

## 2. Zero-Knowledge Secret Provisioning (`/v1/secrets`)

### 2.1 The Cryptographic Handshake

The fundamental constraint: **the platform backend must never see plaintext secrets.** Encryption happens in the end-user's browser; decryption happens only on the Shield proxy. The platform backend is a ciphertext courier.

```
┌──────────────┐     ┌───────────────┐     ┌──────────────┐     ┌──────────┐
│ End-User's   │     │ Platform      │     │ Ellul.ai     │     │ Shield   │
│ Browser      │     │ Backend       │     │ Control Plane│     │ Proxy    │
└──────┬───────┘     └───────┬───────┘     └──────┬───────┘     └────┬─────┘
       │                     │                    │                   │
       │ 1. Fetch proxy's RSA-4096 public key     │                   │
       │    (from workspace provisioning response  │                   │
       │     or GET /v1/workspaces/{id})           │                   │
       │<────────────────────┤                    │                   │
       │                     │                    │                   │
       │ 2. Browser generates:                    │                   │
       │    • AES-256-GCM session key (Ks)        │                   │
       │    • IV (12 bytes, random)                │                   │
       │    • Encrypts secret:                    │                   │
       │      E_sym = AES-GCM(Ks, IV, plaintext)  │                   │
       │    • Encrypts Ks:                        │                   │
       │      E_key = RSA-OAEP-4096(proxy_pub, Ks)│                   │
       │    • Constructs envelope:                │                   │
       │      { E_key, E_sym, IV, fingerprint }    │                   │
       │                     │                    │                   │
       │ 3. POST envelope to platform backend     │                   │
       │    (platform sees ONLY ciphertext)        │                   │
       ├────────────────────>│                    │                   │
       │                     │                    │                   │
       │                     │ 4. POST /v1/secrets │                   │
       │                     │    (forwards envelope + metadata)      │
       │                     ├───────────────────>│                   │
       │                     │                    │                   │
       │                     │                    │ 5. Route envelope  │
       │                     │                    │    to proxy        │
       │                     │                    ├──────────────────>│
       │                     │                    │                   │
       │                     │                    │ 6. Proxy stores   │
       │                     │                    │    envelope on    │
       │                     │                    │    disk (still    │
       │                     │                    │    encrypted)     │
       │                     │                    │                   │
       │                     │                    │ 7. Proxy decrypts │
       │                     │                    │    ONLY during a  │
       │                     │                    │    PoP-gated      │
       │                     │                    │    operation      │
       │                     │                    │    (key in memory  │
       │                     │                    │    for <100ms)    │
```

### 2.2 Envelope Format

```json
{
  "workspace_id": "ws_7kX2mP9q",
  "key_name": "SOLANA_PRIVATE_KEY",
  "gate_types": ["wallet_spend"],

  "envelope": {
    "version": 1,
    "algorithm": "RSA-OAEP-SHA256+AES-256-GCM",
    "proxy_key_fingerprint": "SHA256:a3f9b2c1d4e5...",

    "encrypted_session_key": "<base64: RSA-OAEP encrypted AES-256 key>",
    "encrypted_payload": "<base64: AES-256-GCM ciphertext>",
    "iv": "<base64: 12-byte GCM IV>",
    "auth_tag": "<base64: 16-byte GCM auth tag>"
  },

  "binding": {
    "end_user_id": "usr_ext_9f3a",
    "credential_id": "cred_...",
    "bound_at": "2026-03-30T12:05:00Z",
    "signature": "<base64: end-user signs H(envelope) with passkey during upload>"
  }
}
```

### 2.3 The Binding Signature

The `binding.signature` field is the key non-custodial proof. During secret upload, the browser:

1. Computes `H = SHA-256(encrypted_session_key || encrypted_payload || iv || key_name || workspace_id)`
2. Triggers a WebAuthn `navigator.credentials.get()` assertion with `challenge = H`
3. The resulting assertion signature proves: *"The owner of this passkey authorized the upload of this specific ciphertext to this specific workspace."*

This creates a cryptographic binding between the secret and the passkey. The proxy will only decrypt the envelope during a gate resolution that includes a valid PoP from the **same `credential_id`** that signed the binding. A different passkey cannot unlock a different user's secrets, even if it has access to the proxy.

### 2.4 API Endpoint

```http
POST /v1/workspaces/ws_7kX2mP9q/secrets
Authorization: Bearer sk_live_...
Content-Type: application/json
```

```json
{
  "key_name": "SOLANA_PRIVATE_KEY",
  "gate_types": ["wallet_spend"],
  "envelope": { "...see 2.2..." },
  "binding": { "...see 2.2..." }
}
```

#### Response

```json
{
  "secret_id": "sec_Qm3xR7",
  "workspace_id": "ws_7kX2mP9q",
  "key_name": "SOLANA_PRIVATE_KEY",
  "status": "sealed",
  "proxy_key_fingerprint": "SHA256:a3f9b2c1d4e5...",
  "bound_credential_id": "cred_...",
  "gate_types": ["wallet_spend"],
  "created_at": "2026-03-30T12:05:00Z"
}
```

#### Secret Status Transitions

| From | To | Trigger |
|---|---|---|
| `sealed` | `accessed` | First gate resolution that decrypted it |
| `sealed` | `expired` | Workspace terminated without ever accessing |
| `accessed` | `destroyed` | Workspace completed/terminated, key material zeroed |

### 2.5 How the Agent Uses Secrets (Without Seeing Them)

The agent never requests secrets directly. It makes a normal outbound request through the proxy:

```bash
# Agent's perspective (inside namespace):
curl -X POST http://127.0.0.1:8443/proxy/rpc \
  -H "X-Shield-Gate: wallet_spend" \
  -d '{"jsonrpc":"2.0","method":"sendTransaction","params":["<unsigned_tx_base64>"]}'
```

**What happens at the proxy:**

1. Intercept request, see `X-Shield-Gate: wallet_spend`
2. Pause agent's HTTP connection
3. Emit `gate.pending` webhook to platform
4. Wait for PoP from end-user
5. Verify PoP assertion, check spending constraints
6. Decrypt `SOLANA_PRIVATE_KEY` envelope (key in memory ~50ms)
7. Deserialize unsigned tx, sign with decrypted key
8. Zero key from memory
9. Forward signed tx to Solana RPC
10. Return RPC response to agent
11. Agent sees: `{"result": "tx_signature_5xR2..."}` — **never sees the key**

---

## 3. Asynchronous Gate Flow (The "Pause" Pipeline)

### 3.1 Event Architecture

Two parallel channels serve different consumers:

```
                    ┌─────────────────────┐
                    │    Shield Proxy     │
                    │  (gate triggered)   │
                    └──────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
                    ▼                     ▼
          ┌─────────────────┐   ┌─────────────────┐
          │ Webhook (POST)  │   │ SSE (streaming)  │
          │                 │   │                   │
          │ • Reliable      │   │ • Real-time       │
          │ • Retry w/      │   │ • No retry        │
          │   exponential   │   │   (ephemeral)     │
          │   backoff       │   │ • Low latency     │
          │ • Signed        │   │ • Signed per-     │
          │   (HMAC-SHA256) │   │   event           │
          │ • Idempotent    │   │                   │
          │                 │   │ Target: Platform  │
          │ Target: Platform│   │ frontend for live │
          │ backend for     │   │ UI updates        │
          │ durable state   │   │                   │
          └─────────────────┘   └─────────────────┘
```

### 3.2 Webhook Events

#### `gate.pending` — Agent paused, awaiting human approval

```http
POST https://platform.example.com/webhooks/ellul
Content-Type: application/json
X-Ellul-Signature: sha256=9f3a2b1c...
X-Ellul-Event: gate.pending
X-Ellul-Delivery: del_abc123
X-Ellul-Timestamp: 1743339900
```

```json
{
  "event": "gate.pending",
  "workspace_id": "ws_7kX2mP9q",
  "gate_id": "gate_Tm4nV8",
  "gate_type": "wallet_spend",
  "idempotency_key": "idk_Tm4nV8_1",

  "payload": {
    "chain": "solana",
    "amount_lamports": 500000000,
    "recipient": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "program_id": "11111111111111111111111111111111",
    "memo": "Payment for compute service",
    "unsigned_tx_hash": "SHA256:3Fk9a2b7c1d4..."
  },

  "approval": {
    "url": "https://shield-eu-7kx2.ellul.ai/gate/Tm4nV8/approve?t=eyJ...",
    "challenge": "<base64: 32-byte random challenge for PoP>",
    "credential_id": "cred_...",
    "expires_at": "2026-03-30T12:10:00Z"
  },

  "session": {
    "total_spent_lamports": 1500000000,
    "remaining_budget_lamports": 3500000000,
    "gates_approved_count": 3,
    "gates_denied_count": 0
  },

  "timestamp": "2026-03-30T12:05:00Z"
}
```

### 3.3 Platform Approval Options

The platform has two options for routing the approval to the end-user:

#### Option A: Redirect to hosted approval page (recommended)

The platform surfaces `approval.url` to the end-user (push notification, in-app modal, etc.). The end-user's browser navigates to the Shield proxy's hosted page. The passkey ceremony happens entirely between the browser and the proxy. The platform never touches the WebAuthn assertion.

#### Option B: Proxy the challenge (advanced)

For platforms that want to render the approval UI themselves, they can use the raw `approval.challenge` and `approval.credential_id` to trigger `navigator.credentials.get()` in their own frontend, then POST the assertion back to the proxy:

```http
POST https://shield-eu-7kx2.ellul.ai/gate/Tm4nV8/resolve
Content-Type: application/json
```

```json
{
  "action": "approve",
  "assertion": {
    "credential_id": "cred_...",
    "authenticator_data": "<base64>",
    "client_data_json": "<base64>",
    "signature": "<base64>"
  }
}
```

**The proxy verifies:**

1. `credential_id` matches the one bound to this workspace's secrets
2. `client_data_json.challenge` matches the challenge issued for this gate
3. `client_data_json.origin` is in the allowlisted RP origins (the proxy's own domain OR the platform's registered domain)
4. The assertion signature is valid against the stored public key
5. The spending constraints in the gate policy are satisfied

> **Critical:** Even in Option B, the WebAuthn assertion goes directly from the end-user's browser to the Shield proxy endpoint. The platform backend is not in the assertion's data path. The platform frontend acts as a UI shell — the cryptographic ceremony is between the authenticator and the proxy's RP.

### 3.4 `gate.resolved` — Gate approved or denied

```json
{
  "event": "gate.resolved",
  "workspace_id": "ws_7kX2mP9q",
  "gate_id": "gate_Tm4nV8",
  "gate_type": "wallet_spend",
  "resolution": "approved",

  "result": {
    "tx_signature": "5xR2a8b3c9d1e7f4...",
    "amount_lamports": 500000000,
    "recipient": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "block_hash": "GHtXQBsoZE..."
  },

  "proof": {
    "assertion_hash": "SHA256:c4d5e6f7...",
    "approved_at": "2026-03-30T12:06:12Z",
    "proxy_signature": "<base64: proxy signs the gate resolution record>"
  },

  "timestamp": "2026-03-30T12:06:13Z"
}
```

### 3.5 `gate.timeout` — End-user didn't respond

```json
{
  "event": "gate.resolved",
  "workspace_id": "ws_7kX2mP9q",
  "gate_id": "gate_Tm4nV8",
  "resolution": "timeout",
  "agent_received_status": 408,
  "timestamp": "2026-03-30T12:10:00Z"
}
```

### 3.6 SSE Channel

```http
GET /v1/workspaces/ws_7kX2mP9q/events
Authorization: Bearer sk_live_...
Accept: text/event-stream
```

```
: heartbeat
id: evt_001
event: workspace.status
data: {"status":"running","uptime_seconds":42}

id: evt_002
event: gate.pending
data: {"gate_id":"gate_Tm4nV8","gate_type":"wallet_spend","amount_lamports":500000000,"approval_url":"https://shield-eu-7kx2.ellul.ai/gate/Tm4nV8/approve?t=eyJ...","expires_at":"2026-03-30T12:10:00Z"}

id: evt_003
event: gate.resolved
data: {"gate_id":"gate_Tm4nV8","resolution":"approved","tx_signature":"5xR2a8b3..."}

id: evt_004
event: workspace.completed
data: {"exit_code":0,"duration_seconds":312,"gates_total":4,"gates_approved":3,"gates_denied":1}
```

### 3.7 Agent-Side Blocking

From the agent's perspective, there is no "pause" mechanism to implement. The agent makes an HTTP request to the proxy and the response simply takes a long time:

```
Timeline (agent's view):

T+0.000s  POST /proxy/rpc {...unsigned tx...}
          |
          |  ... agent's HTTP client blocks here ...
          |  ... no timeout needed (proxy sends TCP keepalives) ...
          |
T+72.3s   200 OK {"result": "tx_signature_5xR2..."}
          |
          Agent continues execution.
```

The proxy sends TCP keepalive frames every 15 seconds to prevent intermediate load balancers from killing the connection. The agent's HTTP client must be configured with a timeout >= `gate_policy.default_ttl_seconds` (default 300s).

**On denial:**

```json
// HTTP 403
{
  "error": "gate_denied",
  "gate_id": "gate_Tm4nV8",
  "gate_type": "wallet_spend",
  "reason": "end_user_denied",
  "message": "The wallet_spend operation was denied by the workspace owner."
}
```

**On timeout:**

```json
// HTTP 408
{
  "error": "gate_timeout",
  "gate_id": "gate_Tm4nV8",
  "gate_type": "wallet_spend",
  "ttl_seconds": 300,
  "message": "No approval received within the gate TTL."
}
```

---

## 4. Audit & Provability (`/v1/audit`)

### 4.1 Audit Log Structure

Every workspace produces a tamper-evident audit log. Each entry is individually signed by the Shield proxy's private key, and entries are hash-chained.

```
┌─────────────────────────────────────────────────────┐
│                  AUDIT CHAIN                         │
│                                                     │
│  Entry 0 (genesis)                                  │
│  ┌───────────────────────────────────────────┐      │
│  │ sequence: 0                                │      │
│  │ event: workspace.created                   │      │
│  │ prev_hash: null                            │      │
│  │ data_hash: SHA256(event_data)              │      │
│  │ entry_hash: SHA256(sequence|prev|data)     │      │
│  │ proxy_signature: RSA-PSS(entry_hash)       │      │
│  └─────────────────────┬─────────────────────┘      │
│                        │                             │
│  Entry 1               ▼                             │
│  ┌───────────────────────────────────────────┐      │
│  │ sequence: 1                                │      │
│  │ event: secret.sealed                       │      │
│  │ prev_hash: entry_0.entry_hash              │      │
│  │ data_hash: SHA256(event_data)              │      │
│  │ entry_hash: SHA256(sequence|prev|data)     │      │
│  │ proxy_signature: RSA-PSS(entry_hash)       │      │
│  └─────────────────────┬─────────────────────┘      │
│                        │                             │
│  Entry 2               ▼                             │
│  ┌───────────────────────────────────────────┐      │
│  │ sequence: 2                                │      │
│  │ event: gate.pending                        │      │
│  │ prev_hash: entry_1.entry_hash              │      │
│  │ ...                                        │      │
│  └─────────────────────┬─────────────────────┘      │
│                        │                             │
│                        ▼  ... continues ...          │
└─────────────────────────────────────────────────────┘
```

### 4.2 Audit Event Types

| Event | Data Recorded | Proves |
|---|---|---|
| `workspace.created` | Gate policy hash, network policy hash, proxy public key | What constraints were in place |
| `passkey.registered` | Credential ID, AAGUID, attestation format | Which physical authenticator was bound |
| `secret.sealed` | Key name, envelope hash, binding signature | End-user authorized this specific secret for this workspace |
| `secret.accessed` | Key name, gate_id that triggered access, duration_ms key was in memory | Secret was only decrypted during an approved gate |
| `secret.destroyed` | Key name, zeroing confirmation | Secret material was wiped |
| `gate.pending` | Gate type, constraints snapshot, unsigned tx hash | What the agent requested |
| `gate.approved` | Gate ID, WebAuthn assertion hash, assertion origin, spending ledger state | Human physically approved with their authenticator |
| `gate.denied` | Gate ID, reason (user_denied / timeout / constraint_violation) | Why the operation was blocked |
| `egress.allowed` | Destination host, port, bytes transferred | What network traffic the agent generated |
| `egress.blocked` | Destination host, port, rule that blocked it | What the agent tried and was prevented from doing |
| `workspace.completed` | Exit code, duration, resource usage | Clean termination |

### 4.3 Retrieve Full Audit Chain

```http
GET /v1/workspaces/ws_7kX2mP9q/audit
Authorization: Bearer sk_live_...
Accept: application/json
```

```json
{
  "workspace_id": "ws_7kX2mP9q",
  "chain_length": 47,
  "chain_hash": "SHA256:f1e2d3c4b5a6...",
  "proxy_public_key_pem": "-----BEGIN PUBLIC KEY-----\n...",

  "entries": [
    {
      "sequence": 0,
      "event": "workspace.created",
      "timestamp": "2026-03-30T12:00:01Z",
      "data": {
        "gate_policy_hash": "SHA256:1a2b3c...",
        "network_policy_hash": "SHA256:4d5e6f...",
        "sandbox_runtime": "namespace",
        "region": "eu-central-1"
      },
      "prev_hash": null,
      "data_hash": "SHA256:7g8h9i...",
      "entry_hash": "SHA256:j0k1l2...",
      "proxy_signature": "<base64: RSA-PSS signature over entry_hash>"
    },
    {
      "sequence": 5,
      "event": "gate.approved",
      "timestamp": "2026-03-30T12:06:12Z",
      "data": {
        "gate_id": "gate_Tm4nV8",
        "gate_type": "wallet_spend",
        "unsigned_tx_hash": "SHA256:3Fk9a2...",
        "signed_tx_hash": "SHA256:8Xm2b7...",
        "amount_lamports": 500000000,
        "recipient": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        "assertion_hash": "SHA256:c4d5e6f7...",
        "assertion_origin": "https://shield-eu-7kx2.ellul.ai",
        "credential_id": "cred_...",
        "session_spend_total_lamports": 2000000000,
        "session_spend_remaining_lamports": 3000000000
      },
      "prev_hash": "SHA256:m3n4o5...",
      "data_hash": "SHA256:p6q7r8...",
      "entry_hash": "SHA256:s9t0u1...",
      "proxy_signature": "<base64>"
    }
  ]
}
```

### 4.4 Downloadable Signed Bundle

For compliance teams that need an offline-verifiable artifact:

```http
GET /v1/workspaces/ws_7kX2mP9q/audit/bundle
Authorization: Bearer sk_live_...
Accept: application/octet-stream
```

Returns a CBOR-encoded bundle containing:

- The full audit chain (all entries)
- The proxy's X.509 certificate (chained to Ellul.ai's root CA)
- A detached RSA-PSS signature over the entire bundle

### 4.5 Independent Verification

A platform's compliance team (or their auditor) can verify the entire chain with **zero trust in Ellul.ai's API**:

```python
# Pseudocode: independent audit chain verification

import hashlib, json
from cryptography.hazmat.primitives.asymmetric import padding, utils

def verify_audit_chain(bundle):
    entries = bundle["entries"]
    proxy_pubkey = load_pem_public_key(bundle["proxy_public_key_pem"])

    for i, entry in enumerate(entries):
        # 1. Verify hash chain integrity
        expected_data_hash = sha256(canonical_json(entry["data"]))
        assert entry["data_hash"] == expected_data_hash

        if i == 0:
            assert entry["prev_hash"] is None
        else:
            assert entry["prev_hash"] == entries[i - 1]["entry_hash"]

        expected_entry_hash = sha256(
            f'{entry["sequence"]}|{entry["prev_hash"]}|{entry["data_hash"]}'
        )
        assert entry["entry_hash"] == expected_entry_hash

        # 2. Verify proxy signature (proves entry was written by the proxy)
        proxy_pubkey.verify(
            base64_decode(entry["proxy_signature"]),
            entry["entry_hash"].encode(),
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=32
            ),
            utils.Prehashed(hashes.SHA256())
        )

        # 3. For gate.approved events, verify the WebAuthn assertion hash exists
        if entry["event"] == "gate.approved":
            assert "assertion_hash" in entry["data"]
            # The platform can cross-reference this with the WebAuthn
            # assertion they received in the gate.resolved webhook

    # 4. Verify chain completeness (no gaps in sequence numbers)
    sequences = [e["sequence"] for e in entries]
    assert sequences == list(range(len(entries)))

    return True  # Chain is intact, all signatures valid
```

### 4.6 What This Proves to Enterprise Customers

A platform can hand this audit bundle to their enterprise client's security team. The bundle mathematically proves:

| Claim | Evidence in Chain |
|---|---|
| "The agent was sandboxed" | `workspace.created` records the isolation parameters |
| "The agent never saw the private key" | `secret.sealed` -> `secret.accessed` (only during gate) -> `secret.destroyed`. No `secret.exported` event exists in the schema. |
| "Every transaction was human-approved" | Each `gate.approved` contains the WebAuthn assertion hash, verifiable against the registered credential's public key |
| "Spending limits were enforced" | `gate.approved` entries include running totals. `gate.denied` entries with `constraint_violation` prove the proxy blocked over-limit requests. |
| "Network access was restricted" | `egress.allowed` and `egress.blocked` entries show exactly what the agent could and couldn't reach |
| "No entry was tampered with" | Hash chain + RSA-PSS signatures. Modifying any entry breaks the chain. |

---

## 5. Full Integration Timeline

For a platform integrating from scratch:

### Day 1: API Key + First Host (Per Tenant)

```
POST /v1/hosts { tenant_id: "acme_corp", region: "eu-central-1" }
  → host_id, proxy public key, proxy endpoint
  → Host provisioning takes ~3 minutes (one-time per tenant per region)
  → Host is permanently bound to "acme_corp"
  → Status transitions: provisioning → ready
```

### Day 2: First Workspace (Fast — Per Employee)

```
POST /v1/hosts/{id}/workspaces { end_user_id: "employee_1", gate_policy, network_policy, callbacks }
  → workspace_id, passkey registration URL
  → Namespace creation takes ~2 seconds (host already running)
  → Status: awaiting_registration

Platform embeds passkey registration URL in their onboarding flow
Employee registers their passkey (scoped to this workspace)
  → Status: ready
```

### Day 3: Secret Provisioning

```
Platform's frontend encrypts user's Solana key with proxy's RSA-4096 pubkey
POST /v1/workspaces/{id}/secrets → envelope stored on proxy
End-user signs binding with passkey (proves they authorized this key for this workspace)
```

### Day 4: Agent Execution

```
POST /v1/workspaces/{id}/execute → agent boots in workspace's namespace
Agent hits wallet_spend gate → proxy pauses
Platform receives gate.pending webhook → surfaces approval URL to end-user
End-user touches passkey → proxy signs tx → agent broadcasts
Platform receives gate.resolved webhook → updates their UI
```

### Day 5: Scale — More Employees on Same Host

```
POST /v1/hosts/{id}/workspaces { end_user_id: "employee_2", ... }
POST /v1/hosts/{id}/workspaces { end_user_id: "employee_3", ... }
  → Each workspace: ~2 seconds to create
  → Each workspace: independent passkey, secrets, gates, audit chain
  → Up to 50 workspaces per host (configurable)
  → All share the same proxy endpoint and RSA public key
  → All employees belong to the same tenant ("acme_corp")
```

### Day 6: Compliance

```
GET /v1/workspaces/{id}/audit/bundle → download signed audit chain (per workspace)
Platform's security team verifies chain independently
Hands bundle to enterprise client as proof of non-custodial execution
```

### Auto-Host Mode (Simplified)

For platforms that don't want to manage hosts:

```
POST /v1/workspaces { tenant_id: "acme_corp", end_user_id: "emp_1", region, ... }
  → Control plane finds a host bound to "acme_corp" (or provisions one)
  → First call per tenant: ~3 minutes (host provisioning)
  → Subsequent calls for same tenant: ~2 seconds (namespace on their host)
  → Platform never needs to call /v1/hosts directly

POST /v1/workspaces { tenant_id: "acme_corp", end_user_id: "emp_2", region, ... }
  → Same tenant → reuses acme_corp's existing host (fast, seconds)

POST /v1/workspaces { tenant_id: "globex_inc", end_user_id: "emp_1", region, ... }
  → globex_inc ≠ acme_corp → cannot reuse acme_corp's host
  → Provisions a new dedicated host for globex_inc
  → 1 Tenant = 1 Kernel: always enforced, no exceptions
```

---

## 6. Webhook Security & Reliability

### 6.1 Signature Verification

Every webhook is signed with HMAC-SHA256 using the platform's `webhook_secret`:

```
signature = HMAC-SHA256(
    key = webhook_secret,
    message = timestamp + "." + request_body
)

X-Ellul-Signature: sha256=<hex(signature)>
X-Ellul-Timestamp: <unix_seconds>
```

**Platforms must:**

1. Reject requests where `abs(now - timestamp) > 300` (prevents replay)
2. Compute the expected signature and compare in constant time

### 6.2 Delivery Guarantees

| Property | Behavior |
|---|---|
| **Retry policy** | Exponential backoff: 5s, 30s, 2m, 15m, 1h, 6h (6 attempts) |
| **Idempotency** | Every event has `idempotency_key`. Platforms must deduplicate. |
| **Ordering** | Events within a workspace are ordered by `sequence` (same as audit chain). Cross-workspace ordering is not guaranteed. |
| **Timeout** | Platform must respond with 2xx within 10 seconds or the delivery is retried. |
| **Dead letter** | After 6 failed attempts, the event is written to a dead letter queue accessible via `GET /v1/webhooks/dead-letter` |

---

## 7. Error Taxonomy

| HTTP Status | Error Code | Description |
|---|---|---|
| `400` | `invalid_request` | Malformed payload, missing required fields |
| `401` | `authentication_failed` | Invalid or expired API key |
| `403` | `gate_denied` | Gate denied by end-user or constraint violation |
| `404` | `not_found` | Workspace/gate/secret doesn't exist |
| `408` | `gate_timeout` | PoP not received within TTL |
| `409` | `conflict` | Workspace already in terminal state, or idempotency key reused with different payload |
| `422` | `policy_violation` | Request violates gate policy constraints (e.g., amount exceeds max_per_tx) |
| `429` | `rate_limited` | Per-workspace or per-API-key rate limit hit |
| `500` | `internal_error` | Shield proxy or control plane failure |
| `503` | `workspace_unavailable` | Proxy unreachable (host maintenance, etc.) |

All errors return:

```json
{
  "error": "gate_denied",
  "gate_id": "gate_Tm4nV8",
  "message": "Human-readable explanation",
  "docs_url": "https://docs.ellul.ai/errors/gate_denied",
  "request_id": "req_abc123"
}
```

---

## 8. Hardware Attestation (`/v1/attestation`)

### 8.1 The Trust Gap

Sections 1–7 prove **what happened** inside a workspace — the audit chain is tamper-evident and cryptographically signed. But a sophisticated adversary can ask a deeper question: *"How do I know the audit chain was produced by a genuine Ellul.ai Shield proxy running on untampered hardware, and not a spoofed environment that fabricated the entire chain?"*

The audit chain's RSA-PSS signatures prove the proxy's private key signed each entry. But if an attacker controlled the host, they could generate their own RSA keypair, run a fake "proxy" that produces a valid-looking chain, and present it as genuine. The chain would verify — but it would be fiction.

Hardware attestation closes this gap. It uses a **Trusted Platform Module (TPM 2.0)** physically soldered to the server's motherboard to produce a cryptographic proof that:

1. The server's boot chain is untampered (firmware, bootloader, kernel, initramfs)
2. The Shield proxy binary running on the host matches a known-good hash
3. The proxy's RSA signing key was generated inside (or sealed to) the TPM, meaning it can only be used on **this specific physical machine** in **this specific software state**

```
┌──────────────────────────────────────────────────────────────────┐
│                    THE ATTESTATION STACK                          │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ Layer 0: TPM 2.0 (Hardware Root of Trust)                │    │
│  │                                                          │    │
│  │  • Endorsement Key (EK): Factory-burned, unique per chip │    │
│  │  • Attestation Key (AK): Generated on first boot,       │    │
│  │    certified by EK                                       │    │
│  │  • Platform Configuration Registers (PCRs):              │    │
│  │    SHA-256 accumulators extended at each boot stage       │    │
│  └──────────────────────┬───────────────────────────────────┘    │
│                         │ extends                                │
│  ┌──────────────────────▼───────────────────────────────────┐    │
│  │ Layer 1: Measured Boot Chain                              │    │
│  │                                                          │    │
│  │  PCR[0]  ← UEFI firmware hash                            │    │
│  │  PCR[4]  ← Bootloader (GRUB/systemd-boot) hash           │    │
│  │  PCR[5]  ← Bootloader config hash                        │    │
│  │  PCR[8]  ← Kernel command line hash                       │    │
│  │  PCR[9]  ← Kernel + initramfs hash                        │    │
│  │  PCR[14] ← IMA (Integrity Measurement Architecture)      │    │
│  │            policy hash                                    │    │
│  └──────────────────────┬───────────────────────────────────┘    │
│                         │ extends                                │
│  ┌──────────────────────▼───────────────────────────────────┐    │
│  │ Layer 2: Application Measurements (Custom PCRs)           │    │
│  │                                                          │    │
│  │  PCR[15] ← Shield proxy binary hash                       │    │
│  │  PCR[15] ← Shield proxy config hash                       │    │
│  │  PCR[15] ← Namespace isolation policy hash                │    │
│  │  PCR[15] ← iptables ruleset hash                          │    │
│  └──────────────────────┬───────────────────────────────────┘    │
│                         │                                        │
│  ┌──────────────────────▼───────────────────────────────────┐    │
│  │ Layer 3: Key Sealing                                      │    │
│  │                                                          │    │
│  │  The proxy's RSA-4096 signing key is sealed to            │    │
│  │  PCR[0,4,5,8,9,15]. The TPM will only unseal             │    │
│  │  the key if ALL PCR values match the state at             │    │
│  │  seal time. Any modification to firmware, kernel,         │    │
│  │  or proxy binary makes the key permanently                │    │
│  │  inaccessible.                                            │    │
│  └──────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

### 8.2 TPM Quote: The Cryptographic Proof

A TPM Quote is a signed snapshot of the PCR values at a given moment. The TPM's Attestation Key (AK) signs the quote — and the AK is itself certified by the Endorsement Key (EK), which is burned into the chip at manufacturing and has a certificate chain back to the TPM vendor (Infineon, STMicroelectronics, etc.).

```
┌───────────────┐
│ TPM Vendor CA │  (Infineon, STMicro, etc.)
│ Root Cert     │
└───────┬───────┘
        │ signs
        ▼
┌───────────────┐
│ Endorsement   │  Factory-burned into TPM chip.
│ Key (EK) Cert │  Unique per physical server.
└───────┬───────┘
        │ certifies
        ▼
┌───────────────┐
│ Attestation   │  Generated on first boot.
│ Key (AK)      │  Certified by EK via TPM2_ActivateCredential.
└───────┬───────┘
        │ signs
        ▼
┌───────────────┐
│ TPM Quote     │  Signed snapshot of PCR values + nonce.
│ (PCR values + │  Proves: "This specific hardware, in this
│  nonce +      │  specific software state, at this specific
│  AK signature)│  time."
└───────────────┘
```

The verification chain: **TPM Vendor CA -> EK Certificate -> AK Credential -> Quote Signature -> PCR Values -> Known-Good Reference Values**.

If any link breaks, the attestation fails. No software-only attack can forge this — it requires physical access to the TPM chip.

### 8.3 API Surface

#### Request a Fresh Attestation

```http
POST /v1/workspaces/ws_7kX2mP9q/attestation
Authorization: Bearer sk_live_...
Content-Type: application/json
```

```json
{
  "nonce": "<base64: 32 bytes, platform-generated>",
  "pcr_selection": [0, 4, 5, 8, 9, 15],
  "include_event_log": true
}
```

The `nonce` is critical — it proves freshness. Without it, an attacker could replay an old quote from when the system was in a good state. The platform generates the nonce, so the platform controls the freshness guarantee.

#### Response

```json
{
  "workspace_id": "ws_7kX2mP9q",
  "host_id": "host_eu_7kx2",
  "attestation_time": "2026-03-30T12:00:05Z",

  "tpm_quote": {
    "raw_quote": "<base64: TPMS_ATTEST structure>",
    "quote_signature": "<base64: AK signature over the quote>",
    "signature_algorithm": "RSASSA-PSS-SHA256",

    "pcr_values": {
      "hash_algorithm": "sha256",
      "pcrs": {
        "0":  "a1b2c3d4e5f6...firmware hash...",
        "4":  "b2c3d4e5f6a1...bootloader hash...",
        "5":  "c3d4e5f6a1b2...boot config hash...",
        "8":  "d4e5f6a1b2c3...kernel cmdline hash...",
        "9":  "e5f6a1b2c3d4...kernel+initramfs hash...",
        "15": "f6a1b2c3d4e5...shield proxy + config hash..."
      }
    },

    "nonce_in_quote": "<base64: echoed nonce, embedded in TPMS_ATTEST>"
  },

  "certificate_chain": {
    "ak_cert_pem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "ek_cert_pem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "tpm_vendor_ca_pem": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
  },

  "reference_values": {
    "version": "2026.03.30-1",
    "published_at": "https://trust.ellul.ai/reference-values/2026.03.30-1.json",
    "signature": "<base64: Ellul.ai release key signs the reference values>",

    "expected_pcrs": {
      "0":  "a1b2c3d4e5f6...expected firmware...",
      "4":  "b2c3d4e5f6a1...expected bootloader...",
      "5":  "c3d4e5f6a1b2...expected boot config...",
      "8":  "d4e5f6a1b2c3...expected kernel cmdline...",
      "9":  "e5f6a1b2c3d4...expected kernel+initramfs...",
      "15": "f6a1b2c3d4e5...expected shield binary+config..."
    }
  },

  "event_log": {
    "format": "TCG_PCClientPCREvent",
    "entries": [
      {
        "pcr_index": 0,
        "event_type": "EV_S_CRTM_VERSION",
        "digest": "a1b2c3d4...",
        "event_data": "UEFI firmware v2.4.1 (Hetzner Cloud)"
      },
      {
        "pcr_index": 9,
        "event_type": "EV_IPL",
        "digest": "e5f6a1b2...",
        "event_data": "vmlinuz-6.1.0-ellul-hardened"
      },
      {
        "pcr_index": 15,
        "event_type": "EV_APPLICATION",
        "digest": "f6a1b2c3...",
        "event_data": "sovereign-shield v3.2.0 SHA256:f6a1b2c3..."
      },
      {
        "pcr_index": 15,
        "event_type": "EV_APPLICATION",
        "digest": "a7b8c9d0...",
        "event_data": "namespace-policy: ptrace_scope=1, hidepid=2, pid_ns=true"
      }
    ]
  }
}
```

### 8.4 Independent Verification

The platform (or their auditor) verifies the attestation with **zero trust in Ellul.ai's API**:

```python
# Pseudocode: independent TPM attestation verification

from tpm2_pytss import ESAPI  # or any TPM2 library
import hashlib

def verify_attestation(attestation, nonce):
    quote = attestation["tpm_quote"]
    certs = attestation["certificate_chain"]
    refs  = attestation["reference_values"]

    # ──────────────────────────────────────────────────────
    # Step 1: Verify the certificate chain back to TPM vendor
    # ──────────────────────────────────────────────────────
    # The TPM vendor CA cert is a well-known root (e.g., Infineon).
    # The verifier fetches it from the vendor's public repository,
    # NOT from the attestation response.
    vendor_ca = fetch_trusted_vendor_ca(certs["tpm_vendor_ca_pem"])

    verify_x509_chain(
        leaf=certs["ak_cert_pem"],
        intermediate=certs["ek_cert_pem"],
        root=vendor_ca
    )
    # This proves: the AK belongs to a real TPM chip made by this vendor.

    # ──────────────────────────────────────────────────────
    # Step 2: Verify the quote signature
    # ──────────────────────────────────────────────────────
    ak_public_key = extract_public_key(certs["ak_cert_pem"])

    ak_public_key.verify(
        signature=base64_decode(quote["quote_signature"]),
        data=base64_decode(quote["raw_quote"]),
        padding=PSS(mgf=MGF1(SHA256()), salt_length=32),
        algorithm=SHA256()
    )
    # This proves: the quote was produced by this specific TPM chip.

    # ──────────────────────────────────────────────────────
    # Step 3: Verify the nonce (freshness)
    # ──────────────────────────────────────────────────────
    attest_structure = parse_tpms_attest(quote["raw_quote"])
    assert attest_structure.extra_data == nonce
    # This proves: the quote was generated NOW, not replayed.

    # ──────────────────────────────────────────────────────
    # Step 4: Verify PCR values match the quote
    # ──────────────────────────────────────────────────────
    pcr_digest = compute_pcr_digest(quote["pcr_values"]["pcrs"])
    assert attest_structure.attested.pcr_digest == pcr_digest
    # This proves: the PCR values weren't modified after signing.

    # ──────────────────────────────────────────────────────
    # Step 5: Compare PCR values against known-good references
    # ──────────────────────────────────────────────────────
    # The reference values are published by Ellul.ai and signed
    # with their release key. The verifier can also independently
    # reproduce them by building the same firmware/kernel/binary
    # from source (reproducible builds).
    verify_reference_signature(refs)

    for pcr_index, expected in refs["expected_pcrs"].items():
        actual = quote["pcr_values"]["pcrs"][pcr_index]
        assert actual == expected, (
            f"PCR[{pcr_index}] mismatch: expected {expected}, got {actual}. "
            f"The host software has been modified."
        )
    # This proves: the server is running the exact software Ellul.ai published.

    # ──────────────────────────────────────────────────────
    # Step 6 (optional): Replay the event log
    # ──────────────────────────────────────────────────────
    # The event log records every measurement that was extended
    # into each PCR. Replaying it should reproduce the final
    # PCR values exactly. This proves the log wasn't truncated
    # or entries removed.
    simulated_pcrs = {}
    for entry in attestation["event_log"]["entries"]:
        idx = entry["pcr_index"]
        if idx not in simulated_pcrs:
            simulated_pcrs[idx] = b'\x00' * 32
        simulated_pcrs[idx] = hashlib.sha256(
            simulated_pcrs[idx] + bytes.fromhex(entry["digest"])
        ).digest()

    for idx, simulated in simulated_pcrs.items():
        assert simulated.hex() == quote["pcr_values"]["pcrs"][str(idx)]

    return True  # Hardware is genuine, software is untampered
```

### 8.5 Key Sealing: Binding the Proxy Identity to Hardware State

The proxy's RSA-4096 signing key (the one that signs audit chain entries) is **sealed to the TPM**. This means the TPM will only release the key when the PCR values match the state at seal time:

```
Seal time (first boot):
    TPM2_Create(
        parent     = SRK (Storage Root Key),
        sensitive  = proxy_rsa_private_key,
        policy     = PolicyPCR(PCR[0,4,5,8,9,15]),
        attributes = fixedTPM | fixedParent | noDA
    )

Unseal (every boot):
    TPM2_Unseal(
        policy_session = satisfyPolicyPCR(PCR[0,4,5,8,9,15])
    )
    → returns proxy_rsa_private_key IFF current PCRs match seal-time PCRs
    → fails with TPM_RC_POLICY_FAIL if any PCR changed
```

**What this prevents:**

| Attack | Why It Fails |
|---|---|
| Replace the Shield proxy binary | PCR[15] changes -> TPM refuses to unseal the signing key -> proxy cannot produce audit entries -> platform's verification fails |
| Modify the kernel | PCR[9] changes -> same result |
| Boot from a USB stick | PCR[4] changes -> same result |
| Clone the disk to another server | Different TPM chip -> different EK -> AK cert chain verification fails |
| Extract the key from a memory dump | Key is only in RAM during signing operations (<1ms per entry). `LimitCORE=0` prevents crash dumps. But even if extracted, the key is now unbound from hardware — the attestation quote would show a different AK, and the certificate chain wouldn't validate. |

### 8.6 Continuous Attestation

A single attestation at workspace creation proves the host was genuine at boot time. But what if the host is compromised *during* execution?

**Event-Anchored Attestation** solves this by embedding a fresh TPM quote into the audit chain at critical moments:

```
Audit Chain:
    ...
    Entry 12: gate.pending (wallet_spend, 5 SOL)
    Entry 13: attestation.quote   ◄── Fresh TPM quote taken BEFORE decrypting the key
    Entry 14: gate.approved       ◄── Proxy decrypted key and signed tx
    ...
```

The `attestation.quote` audit entry contains a full TPM quote with the `entry_hash` of the preceding audit entry as the nonce. This creates a bidirectional binding:

- The **audit chain** contains the quote (proving the quote existed at this point in the chain)
- The **quote's nonce** is the previous entry's hash (proving the quote was generated at this exact position, not replayed from an earlier attestation)

```json
{
  "sequence": 13,
  "event": "attestation.quote",
  "timestamp": "2026-03-30T12:06:11Z",
  "data": {
    "trigger": "pre_gate_resolution",
    "gate_id": "gate_Tm4nV8",
    "nonce_source": "entry_hash_of_sequence_12",
    "tpm_quote": {
      "raw_quote": "<base64>",
      "quote_signature": "<base64>",
      "pcr_values": { "0": "...", "4": "...", "9": "...", "15": "..." }
    },
    "ak_cert_fingerprint": "SHA256:..."
  },
  "prev_hash": "SHA256:...",
  "data_hash": "SHA256:...",
  "entry_hash": "SHA256:...",
  "proxy_signature": "<base64>"
}
```

#### When Continuous Attestation Triggers

| Trigger | Reason |
|---|---|
| `workspace.created` | Baseline: prove the host is genuine before any secrets are loaded |
| Pre-gate resolution (any gate type) | Prove the host is still genuine at the moment secrets are decrypted |
| `secret.sealed` | Prove the host is genuine when receiving encrypted secrets |
| On-demand (`POST /v1/.../attestation`) | Platform can request a fresh quote at any time |
| Periodic (configurable, e.g., every 5 minutes) | Catch delayed compromises between gate events |

### 8.7 Reference Value Publication

Ellul.ai publishes reference PCR values for every release at a well-known URL:

```http
GET https://trust.ellul.ai/reference-values/latest.json
```

```json
{
  "version": "2026.03.30-1",
  "published_at": "2026-03-30T00:00:00Z",
  "release_notes": "https://github.com/ellul-ai/shield/releases/v3.2.0",

  "pcr_references": {
    "sha256": {
      "0":  { "value": "a1b2c3...", "description": "UEFI firmware v2.4.1 (Hetzner Cloud CAX series)" },
      "4":  { "value": "b2c3d4...", "description": "systemd-boot v255" },
      "5":  { "value": "c3d4e5...", "description": "Boot config: console=ttyS0 iomem=strict" },
      "8":  { "value": "d4e5f6...", "description": "Kernel cmdline: root=UUID=... ro quiet" },
      "9":  { "value": "e5f6a1...", "description": "vmlinuz-6.1.0-ellul-hardened + initramfs" },
      "15": { "value": "f6a1b2...", "description": "sovereign-shield v3.2.0 + namespace policy v2" }
    }
  },

  "reproducibility": {
    "build_dockerfile": "https://github.com/ellul-ai/shield/blob/v3.2.0/Dockerfile.reproducible",
    "source_commit": "abc123def456...",
    "build_instructions": "https://docs.ellul.ai/reproducible-builds"
  },

  "signature": "<base64: Ellul.ai release key (Ed25519) signs this document>",
  "signing_key_id": "ellul-release-2026"
}
```

The reference values are signed with Ellul.ai's release key. For maximum trust, the platform can **independently reproduce** the expected PCR values by:

1. Checking out the tagged source commit
2. Building with the reproducible Dockerfile
3. Computing the binary hash
4. Comparing against PCR[15]

This is the same model used by [Sigstore](https://www.sigstore.dev/) and [SLSA](https://slsa.dev/) — verifiable provenance from source to binary.

### 8.8 What This Adds to the Trust Stack

Without attestation (Sections 1–7), the platform trusts that Ellul.ai's infrastructure is genuine because of:
- Contractual agreements (SLA, terms of service)
- SOC 2 Type II audit reports
- Penetration test results
- Reputation

With attestation (Section 8), the platform trusts because of:
- **Physics.** The TPM chip is physically soldered to the motherboard. Its endorsement key is burned at manufacturing. The quote is signed by hardware that cannot be cloned. The PCR values reflect every byte of code that ran since power-on. No contractual agreement required — the math is the proof.

| Trust Level | Mechanism | What It Proves |
|---|---|---|
| **Level 1: Audit Chain** (Sections 1–7) | Hash chain + RSA-PSS signatures | Every operation was logged, ordered, and signed by the proxy |
| **Level 2: Hardware Attestation** (Section 8) | TPM Quote + PCR verification | The proxy is genuine Ellul.ai software running on untampered hardware |
| **Level 3: Continuous Attestation** (Section 8.6) | Event-anchored TPM quotes in audit chain | The hardware was genuine at the exact moment each secret was decrypted |

This is the difference between *"we promise we didn't tamper"* and *"it is physically impossible for us to have tampered."*
