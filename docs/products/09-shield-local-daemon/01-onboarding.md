# Shield Gateway: CLI Onboarding Architecture

> Technical deep-dive into the end-to-end onboarding flow for the Shield Gateway product ($10/mo). Covers every layer from `npm install -g ellul` to a running auth proxy on the developer's machine.

## Table of Contents

1. [Overview](#overview)
2. [The Bootstrapping Problem](#the-bootstrapping-problem)
3. [Complete User Flow](#complete-user-flow)
4. [Architecture Diagram](#architecture-diagram)
5. [Layer 1: CLI Distribution](#layer-1-cli-distribution)
6. [Layer 2: Signup Bridge](#layer-2-signup-bridge)
7. [Layer 3: Console Sign-Up](#layer-3-console-sign-up)
8. [Layer 4: Payment & Provisioning](#layer-4-payment--provisioning)
9. [Layer 5: Setup Token Pipeline](#layer-5-setup-token-pipeline)
10. [Layer 6: ShieldSetupFlow Component](#layer-6-shieldsetupflow-component)
11. [Layer 7: VPS Passkey Registration](#layer-7-vps-passkey-registration)
12. [Layer 8: CLI Callback & Session](#layer-8-cli-callback--session)
13. [Layer 9: Proxy Daemon](#layer-9-proxy-daemon)
14. [Security Model](#security-model)
15. [Storage Strategy](#storage-strategy)
16. [Error Recovery](#error-recovery)
17. [File Reference](#file-reference)

---

## Overview

Shield Gateway is a CLI-first product that runs a local auth proxy between AI coding agents and a remote VPS. Secrets are proxied through the VPS — nothing is stored on the developer's machine. The onboarding flow follows the **Google Cloud CLI model**: `ellul login` opens a browser, the browser handles everything (signup, payment, VPS provisioning, passkey registration), then redirects back to the CLI.

### Three Commands to Running Proxy

```bash
npm install -g ellul          # Install
ellul login                   # Signup + pay + provision + passkey (browser handles it)
ellul                         # Start proxy daemon
```

### Design Principles

- **Google Cloud model** — browser does the heavy lifting, CLI just waits
- **No API keys** — passkey + Proof of Possession (PoP) is the auth model
- **No secrets on disk** — session stored in OS keychain, secrets proxied from VPS
- **First login is slow (3-5 min), every subsequent login is instant** — device fast-path

---

## The Bootstrapping Problem

Shield Gateway has a chicken-and-egg dependency chain:

```
CLI login requires → VPS domain (srv-xxx.ellul.ai)
VPS domain requires → VPS provisioning
VPS provisioning requires → Stripe payment
Stripe payment requires → Account (OAuth)
Passkey auth requires → VPS running with registered passkey
```

**Solution**: The browser flow handles the entire chain sequentially. The CLI opens the browser and waits for a localhost callback. The browser walks the user through OAuth → Stripe → provisioning → passkey → redirect back to CLI with an exchange code.

---

## Complete User Flow

### First-Time User (New Account)

```
Developer                   Browser                      API                VPS
    │                          │                          │                  │
    │  ellul login             │                          │                  │
    │  > Choose: New account   │                          │                  │
    │──opens browser──────────>│                          │                  │
    │                          │  ellul.ai/signup          │                  │
    │                          │──redirect──>console/sign-up                  │
    │                          │  (product=shield_proxy)  │                  │
    │                          │                          │                  │
    │                          │  OAuth (GitHub/Google)   │                  │
    │                          │─────────────────────────>│                  │
    │                          │<─────session─────────────│                  │
    │                          │                          │                  │
    │                          │  Stripe Checkout ($10)   │                  │
    │                          │─────────────────────────>│                  │
    │                          │<─────success─────────────│                  │
    │                          │                          │                  │
    │                          │  [ShieldSetupFlow UI]    │  Provision VPS   │
    │                          │  Step 1: Account ✓       │─────────────────>│
    │                          │  Step 2: Payment ✓       │                  │
    │                          │  Step 3: Provisioning... │<──SSE progress───│
    │                          │  Step 3: Node.js...      │                  │
    │                          │  Step 3: Services...     │                  │
    │                          │  Step 3: ✓               │                  │
    │                          │                          │                  │
    │                          │  Redirect to VPS setup   │                  │
    │                          │──────────────────────────────────────────>  │
    │                          │  /_auth/setup?token=X    │                  │
    │                          │  &callback=localhost     │                  │
    │                          │  &port=Y&nonce=Z         │                  │
    │                          │                          │                  │
    │                          │  Register passkey        │                  │
    │                          │  (biometric prompt)      │                  │
    │                          │  Save recovery codes     │                  │
    │                          │  Click "Continue to CLI" │                  │
    │                          │                          │                  │
    │<──localhost callback─────│                          │                  │
    │  code={exchangeCode}     │                          │                  │
    │  domain={srv-xxx}        │                          │                  │
    │  nonce={Z}               │                          │                  │
    │                          │                          │                  │
    │  Exchange code for       │                          │                  │
    │  session + PoP binding   │                          │                  │
    │─────────────────────────────────────────────────────────────────────>  │
    │<────session + device credential──────────────────────────────────────  │
    │                          │                          │                  │
    │  ✓ Login successful      │                          │                  │
    │  domain: srv-xxx.ellul.ai│                          │                  │
    │                          │                          │                  │
    │  ellul                   │                          │                  │
    │  > Proxy on :9876        │                          │                  │
```

### Returning User (Device Fast-Path)

```
Developer                                                 VPS
    │                                                      │
    │  ellul login                                         │
    │  (device credential found in keychain)               │
    │                                                      │
    │  POST /_auth/device/challenge                        │
    │─────────────────────────────────────────────────────>│
    │<────challenge────────────────────────────────────────│
    │                                                      │
    │  Sign challenge with PoP key                         │
    │  POST /_auth/device/authenticate                     │
    │─────────────────────────────────────────────────────>│
    │<────session──────────────────────────────────────────│
    │                                                      │
    │  ✓ Authenticated via registered device.              │
    │  (No browser needed. Instant.)                       │
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         DEVELOPER'S MACHINE                             │
│                                                                         │
│  ┌──────────┐    ┌─────────────┐    ┌──────────────────┐               │
│  │ AI Agent │───>│ Auth Proxy  │───>│ VPS              │               │
│  │ (Claude, │    │ :9876       │    │ srv-xxx.ellul.ai  │               │
│  │  Cursor) │    │             │    │                   │               │
│  └──────────┘    │ Injects:    │    │ sovereign-shield  │               │
│                  │ - Session   │    │ - Passkey auth    │               │
│  ┌──────────┐    │ - PoP sig   │    │ - Secret vault    │               │
│  │ ellul    │    │ - STS token │    │ - Gate control    │               │
│  │ CLI      │    │             │    │                   │               │
│  │          │    │ Redacts:    │    │ file-api          │               │
│  │ login    │    │ - Secrets   │    │ - Code browser    │               │
│  │ init     │    │ - Tokens    │    │                   │               │
│  │ env      │    │             │    │ enforcer          │               │
│  │ sync     │    └─────────────┘    │ - Heartbeat       │               │
│  └──────────┘                       │ - State enforce   │               │
│                                     └──────────────────┘               │
│  ~/.ellul/                                                              │
│  ├── config.json     (domain)                                           │
│  ├── proxy.port      (port:pid)                                         │
│  └── active-project  (current project slug)                             │
│                                                                         │
│  OS Keychain (macOS security / Linux secret-tool)                       │
│  ├── ai.ellul.sovereign-ide/session    (sessionId, tier, domain)        │
│  └── ai.ellul.sovereign-ide/device.*   (deviceId, PoP private key)      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Layer 1: CLI Distribution

### Package Identity

| Field | Value |
|-------|-------|
| npm name | `ellul` |
| Version | `0.1.1` |
| Binary | `ellul` |
| MCP binary | `ellul-mcp` |
| Config dir | `~/.ellul/` |
| License | BUSL-1.1 |

### Installation

```bash
npm install -g ellul           # Global install
npx ellul login                # One-shot without install
```

### Build & Publish

```json
{
  "main": "dist/index.js",
  "bin": { "ellul": "./dist/index.js", "ellul-mcp": "./dist/mcp-server.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build"
  },
  "publishConfig": { "access": "public" }
}
```

**File**: `packages/cli/package.json`

### Global Rename: `ellul` → `ellul`

All 18 source files in `packages/cli/src/` were renamed:
- Binary name: `ellul` → `ellul`
- Config directory: `~/.ellul/` → `~/.ellul/`
- Help text, error messages, REPL prompts: `ellul` → `ellul`
- MCP server: `ellul` → `ellul`, binary `ellul-mcp` → `ellul-mcp`
- Instruction block markers: `"Managed by ellul"`, `"Run \`ellul sync\`"`
- `.mcp.json` server entry: `servers.ellul = { command: 'npx', args: ['ellul-mcp'] }`

Import paths (`@ellul.ai/auth-proxy`) were NOT changed — the `@ellul.ai` npm scope is the workspace package namespace, not the CLI binary.

---

## Layer 2: Signup Bridge

**File**: `apps/web/src/app/signup/page.tsx` (NEW)

The CLI opens `https://ellul.ai/signup?callback_port=X&nonce=Y&product=shield_proxy`. This URL lives on the marketing domain (`ellul.ai`), but the actual signup flow lives on the console app (`console.ellul.ai`).

The bridge page is a client-side redirect that preserves all query parameters:

```
ellul.ai/signup?callback_port=9999&nonce=abc&product=shield_proxy
       ↓ redirect
console.ellul.ai/sign-up?callback_port=9999&nonce=abc&product=shield_proxy
```

This exists because:
1. The CLI's `SIGNUP_URL` should be the user-facing domain (`ellul.ai`), not an internal app domain
2. The console app handles OAuth and Stripe — the marketing site doesn't
3. Simple Next.js client component, no server-side logic needed

---

## Layer 3: Console Sign-Up

**File**: `apps/console/src/app/sign-up/page.tsx` (MODIFIED)

### Product-Aware Behavior

The sign-up page detects the Shield Gateway flow via the `product` query parameter:

```typescript
const productParam = searchParams.get("product");
const isShieldFlow = productParam === "shield_proxy";
const tiers = isShieldFlow ? CLI_SHIELD_TIERS : PLATFORM_TIERS;
```

When `product=shield_proxy`:
- Auto-selects `shield_proxy` tier (single tier, no picker shown)
- Shows Shield-specific heading: "Shield Gateway"
- Shows Shield-specific subtitle: "Secrets proxied. Nothing stored locally."
- Hides "Change plan" button (Shield has one tier)
- Goes straight to OAuth buttons

### CLI Callback Parameter Storage

Before OAuth redirect, stores CLI callback parameters:

```typescript
// localStorage — survives Stripe Checkout tab bounce
localStorage.setItem("ps_cli_callback_port", callbackPort);
localStorage.setItem("ps_cli_callback_nonce", nonce);

// sessionStorage — consumed by dashboard auto-act on same page load
sessionStorage.setItem("ps_signup_tier", "shield_proxy");
```

**Why localStorage for CLI params**: Stripe Checkout redirects can open in a new tab or different browser context (especially on mobile or magic link flows). `sessionStorage` doesn't survive cross-tab hops. `localStorage` does. The `ps_signup_tier` stays in `sessionStorage` because it's consumed on the same dashboard page load — CLI callback params must survive the Stripe bounce.

### Reused Components

- `CLI_SHIELD_TIERS` from `packages/ui/src/pricing.tsx` (already exported)
- `TierCard` component with `border-orange-500/40` recommended variant styling
- Existing OAuth button layout and styling (GitHub, Google, Apple icons)

---

## Layer 4: Payment & Provisioning

### Auto-Act on Dashboard

**File**: `apps/console/src/app/dashboard/layout.tsx` (MODIFIED)

When the user lands on the dashboard after OAuth, the auto-act logic reads `ps_signup_tier` from sessionStorage:

```typescript
const signupTier = sessionStorage.getItem("ps_signup_tier");
// ...
checkoutMutation.mutate({
  tier: signupTier as "platform_standard" | "platform_pro" | "shield_proxy",
  region,
});
```

This triggers the Stripe Checkout flow automatically — no extra click needed. The `shield_proxy` tier was already accepted by the `checkoutMutation` type union.

### Stripe Webhook → VPS Provisioning

After Stripe payment succeeds:
1. `checkout.session.completed` webhook fires
2. API verifies tier from Stripe subscription price (not metadata — prevents tampering)
3. API provisions a VPS via the serverless engine:
   - Provider: DigitalOcean (`s-1vcpu-512mb-10gb`)
   - Services: sovereign-shield (64MB heap) + file-api (96MB heap) + perfMonitor
   - Firewall: `governance` mode
   - Volume: 10GB block storage
4. VPS boots with cloud-init, runs provisioning payload

### Provisioning Progress (SSE)

The VPS reports progress to the API via `POST /provision-progress`. The API emits SSE events:

```
provision_progress → { step: "packages", label: "Installing system packages..." }
provision_progress → { step: "nodejs",   label: "Setting up Node.js..." }
provision_progress → { step: "services", label: "Starting services..." }
provision_progress → { step: "ready",    label: "Ready" }
```

The `useServerEvents` hook merges these into the React Query cache, driving the ShieldSetupFlow UI.

---

## Layer 5: Setup Token Pipeline

### The Problem

The VPS setup page (`/_auth/setup`) requires a one-time setup token to authorize the first passkey registration. This token is generated on the VPS during provisioning. The console needs this token to redirect the user to the correct URL.

### The Pipeline

```
VPS (crypto-keys.sh)        API (heartbeat.routes.ts)      Console (ShieldSetupFlow)
        │                            │                              │
        │  Generate token            │                              │
        │  openssl rand -hex 32      │                              │
        │  Write to filesystem       │                              │
        │                            │                              │
        │  POST /heartbeat           │                              │
        │  { setupToken: "abc..." }  │                              │
        │───────────────────────────>│                              │
        │                            │  Store in DB                 │
        │                            │  servers.sovereignSetupToken │
        │                            │                              │
        │                            │  GET /status                 │
        │                            │<─────────────────────────────│
        │                            │  { server: {                 │
        │                            │    setupToken: "abc..."      │
        │                            │  }}                          │
        │                            │─────────────────────────────>│
        │                            │                              │
        │                            │                              │  Redirect to VPS:
        │                            │                              │  /_auth/setup?token=abc...
        │                            │                              │  &callback=localhost
        │                            │                              │  &port=9999&nonce=xyz
```

### Step 1: Token Generation (VPS)

**File**: `apps/api/src/provisioning/shell/packages/crypto-keys.sh`

During provisioning, the crypto-keys script generates a setup token if:
- No setup token file exists already
- No auth database exists (first boot, no passkeys)

```bash
SETUP_TOKEN=$(openssl rand -hex 32)
SETUP_EXPIRY=$(($(date +%s) + 3600))  # 1 hour TTL
echo "$SETUP_TOKEN" > "$SETUP_TOKEN_FILE"
echo "$SETUP_EXPIRY" > "$SETUP_EXPIRY_FILE"
chmod 600 "$SETUP_TOKEN_FILE" "$SETUP_EXPIRY_FILE"

# Report to API
curl -4 -sS -X POST "__API_URL__/api/servers/heartbeat" \
  -H "Authorization: Bearer __AI_PROXY_TOKEN__" \
  -d "{\"setupToken\":\"$SETUP_TOKEN\"}"
```

The 1-hour TTL is longer than the web-locked switch script's 10-minute TTL because this is a first-boot scenario where the user may be going through OAuth + Stripe checkout before reaching the setup page.

### Step 2: Token Storage (API)

**File**: `apps/api/src/routes/servers/heartbeat.routes.ts`

The heartbeat handler validates and stores the setup token with defense-in-depth guards:

```typescript
// Parse: 64-char hex string (32 bytes)
if (typeof body.setupToken === "string" && body.setupToken.length === 64) {
  reportedSetupToken = body.setupToken;
}

// Store in DB — triple guard:
// 1. Token must be present
// 2. Server must be in provisioning/creating state (not running — prevents injection)
// 3. No existing token (write-once — prevents overwrite)
...(reportedSetupToken &&
  (server.state === "provisioning" || server.state === "creating") &&
  !server.sovereignSetupToken &&
  { sovereignSetupToken: reportedSetupToken }),
```

**Database column**: `servers.sovereignSetupToken` (text, nullable) — already existed in the schema.

### Step 3: Token Exposure (Status API)

**File**: `apps/api/src/routes/servers/status.routes.ts`

```typescript
server: {
  // ... existing fields ...
  setupToken: server.sovereignSetupToken || null,
}
```

The token is included in the server status response, which the console polls via React Query.

---

## Layer 6: ShieldSetupFlow Component

**File**: `apps/console/src/components/dashboard/ShieldSetupFlow.tsx` (NEW)

### Design

Enterprise-grade provisioning checklist overlay matching the ellul.ai design system:

- Full viewport overlay: `bg-background/95 backdrop-blur-sm`
- Centered card: `panel-ascente p-8 sm:p-12 max-w-md`
- Shield icon in orange accent circle
- 5-step checklist with live status indicators

### Steps

| Step | Status During Provisioning | Status When Ready |
|------|---------------------------|-------------------|
| Account created | done (CheckCircle2, orange) | done |
| Payment confirmed | done | done |
| Provisioning server | active (Spinner) + SSE sub-label | done |
| Setting up passkey | pending (Circle, muted) | active |
| Connecting to CLI | pending | pending |

### Redirect Logic

When `isReady === true` and `setupToken` is available:

```typescript
// Read CLI callback params from localStorage
const callbackPort = localStorage.getItem("ps_cli_callback_port");
const callbackNonce = localStorage.getItem("ps_cli_callback_nonce");

// Clean up before redirect
localStorage.removeItem("ps_cli_callback_port");
localStorage.removeItem("ps_cli_callback_nonce");

// Redirect to VPS setup page (NOT login — no passkeys exist yet)
const vpsSetupUrl = new URL(`https://${serverDomain}/_auth/setup`);
vpsSetupUrl.searchParams.set("token", setupToken);
vpsSetupUrl.searchParams.set("callback", "localhost");
vpsSetupUrl.searchParams.set("port", callbackPort);
vpsSetupUrl.searchParams.set("nonce", callbackNonce);

window.location.href = vpsSetupUrl.toString();
```

**Why `/_auth/setup` and not `/_auth/login`**: The login page (`/_auth/login`) only authenticates existing passkeys. For a new server with zero passkeys, it returns `"No passkeys registered"`. The setup page handles first-time passkey registration.

**Why hard redirect and not fetch**: The console sits on `console.ellul.ai` but the VPS is on `srv-xxx.ellul.ai`. A cross-origin `fetch` with credentials would be blocked by SameSite cookie policies and CORS. A hard `window.location.href` redirect avoids both issues.

### Dashboard Integration

The ShieldSetupFlow is rendered in two states:

**Single unified render block** (no unmount/remount flash between states):

```typescript
const isShieldCliFlow = isShieldProduct && hasCliCallback;

// Single component across provisioning → running transition
if (isShieldCliFlow && (isProvisioningState || isRunningState)) {
  return (
    <ShieldSetupFlow
      operationLabel={serverStatus.operation?.label ?? null}
      isReady={isRunningState}       // transitions false → true without unmount
      serverDomain={serverStatus.server?.domain ?? null}
      setupToken={serverStatus.server?.setupToken ?? null}
    />
  );
}
```

The component has an internal state machine:
- `isReady=false` → provisioning checklist with live SSE labels
- `isReady=true, setupToken=null` → "Connecting to server..." with 90s timeout
- `isReady=true, setupToken=string` → redirect to VPS setup page
- Token timeout → error state with retry button

---

## Layer 7: VPS Passkey Registration

**File**: `packages/vps/src/services/auth/sovereign-shield/src/routes/setup.routes.ts` (MODIFIED)

### Localhost Callback Support

The setup page now supports the same localhost callback flow used by the login page (VS Code extension pattern).

**Query parameter parsing** (client-side JavaScript):

```javascript
const _params = new URLSearchParams(window.location.search);
const _isLocalhostCallback = _params.get('callback') === 'localhost';
const _callbackPort = _params.get('port') || _params.get('callback_port');  // accepts both
const _callbackNonce = _params.get('nonce');
```

Both `port` and `callback_port` param names are accepted for forward compatibility (the CLI sends `callback_port`, the console sends `port`). The login page has the same dual-accept.

### Exchange Code Strategy (TTL-Safe)

The `/_auth/register/verify` endpoint returns an `exchangeCode` alongside the session, but this code has a 30-second TTL. If the user takes time to save recovery codes, the code expires.

**Solution**: The setup page does NOT use the registration-time exchange code for the CLI redirect. Instead, after passkey registration, it redirects to the login page with `autostart=1`:

```javascript
const loginRedirectUrl = '/_auth/login?callback=localhost'
  + '&port=' + encodeURIComponent(_callbackPort)
  + '&nonce=' + encodeURIComponent(_callbackNonce)
  + '&autostart=1';
```

The login page auto-triggers passkey auth (instant — biometric is cached from seconds ago), generates a **fresh** exchange code with a full 30-second TTL, and redirects to localhost. No stale codes, regardless of how long the user takes to save recovery codes.

### Post-Registration Flow

After successful passkey registration:

```javascript
if (_isLocalhostCallback && _callbackPort && /^\d+$/.test(_callbackPort) && _callbackNonce) {
  const loginRedirectUrl = '/_auth/login?callback=localhost'
    + '&port=' + encodeURIComponent(_callbackPort)
    + '&nonce=' + encodeURIComponent(_callbackNonce)
    + '&autostart=1';

  if (result.recoveryCodes && result.recoveryCodes.length > 0) {
    // Show "Continue to CLI" button — user must save recovery codes first
    const continueBtn = document.createElement('button');
    continueBtn.className = 'auth-btn';
    continueBtn.innerHTML = '→ Continue to CLI';
    continueBtn.onclick = function() { window.location.href = loginRedirectUrl; };
    document.getElementById('recovery-section').appendChild(continueBtn);
  } else {
    // No recovery codes — redirect to login immediately
    window.location.href = loginRedirectUrl;
  }
}
```

**Recovery code safety**: If this is the first passkey (recovery codes generated), the redirect does NOT happen automatically. A "Continue to CLI" button appears below the recovery codes. The user must actively acknowledge the codes before being redirected.

### Security Properties

- Redirect target is hardcoded to `127.0.0.1` (in login.routes.ts, not user-configurable)
- Port must match numeric regex `/^\d+$/`
- Nonce must exist (prevents CSRF)
- Exchange code is generated fresh at redirect time (not stale from registration)
- Exchange code is single-use with 30-second TTL
- Setup token validated server-side before allowing registration
- Domain extracted from hostname, not user input
- Both `port` and `callback_port` accepted for compatibility

---

## Layer 8: CLI Callback & Session

**File**: `packages/cli/src/commands/login.ts` (MODIFIED)

### Callback Server

The CLI starts a localhost HTTP server on a random port before opening the browser:

```typescript
const { server, port, resultPromise } = createCallbackServer(nonce, abortController.signal);
```

The callback server:
- Binds to `127.0.0.1` only (prevents external connections)
- Validates nonce matches expected value (CSRF protection)
- Extracts `code`, `nonce`, and `domain` from callback URL
- 5-minute timeout with clear error message

### Code Exchange

After receiving the callback:

```typescript
const session = await exchangeCode(
  finalDomain,
  callback.code,
  bindProof.publicKey,
  bindProof.timestamp,
  bindProof.signature,
);
```

This calls `POST https://srv.{domain}/_auth/client/exchange` with:
- `code` — one-time exchange code (30s TTL, single-use)
- `popPublicKey` — ECDSA P-256 public key for Proof of Possession
- `popTimestamp` + `popSignature` — proves key ownership

The VPS returns `{ sessionId, tier, expiresAt }`.

### Session Storage

The session is stored in the OS keychain:
- **macOS**: `security add-generic-password` with service `ai.ellul.sovereign-ide`
- **Linux**: `secret-tool store` with the same service name

The domain is written to `~/.ellul/config.json`.

### Device Registration

After successful login, the CLI registers itself as a trusted device:

```typescript
await registerDevice(finalDomain, session.sessionId, popKeyPair, cliHost);
```

This enables the **fast-path** for subsequent logins — no browser needed, just PoP challenge-response.

---

## Layer 9: Proxy Daemon

After `ellul login`, the user starts the proxy daemon:

```bash
ellul                  # Interactive mode (default)
ellul --domain=X       # Override domain
```

The daemon orchestrates:

1. **AuthProxyEngine** — HTTP proxy on `127.0.0.1:{random_port}`
2. **StsManager** — per-project STS token lifecycle (15-min TTL, auto-refresh)
3. **ProjectRegistry** — multi-project state management
4. **BackgroundSyncManager** — local→VPS file sync (3-layer)
5. **GateStream** — SSE gate event receiver
6. **ContentHasher** — Merkle tree workspace hashing
7. **Interactive REPL** — developer control plane

The proxy injects auth headers into all requests:
- `Cookie: shield_session={sessionId}` — session identity
- `X-PoP-Timestamp`, `X-PoP-Nonce`, `X-PoP-Signature` — PoP proof (for web_locked tier)
- `X-STS-Token` — per-project scoped token (when X-Ellul-Project header present)

---

## Security Model

### Authentication Chain

```
Device credential (OS keychain)
    │
    ├─ PoP private key (ECDSA P-256, never leaves device)
    ├─ Device ID (registered with VPS)
    └─ Trust expiry (sliding window, server-controlled)
         │
         └─ Session (bound to IP + fingerprint)
              │
              ├─ Session cookie (VPS-scoped)
              ├─ PoP signature (per-request)
              └─ Operator key (RAM-only, daemon lifetime)
                   │
                   └─ Gate approvals (operator-signed, agent-proof)
```

### Threat Mitigations

| Threat | Mitigation |
|--------|-----------|
| CSRF on localhost callback | Nonce validation (generated by CLI, verified on callback) |
| Open redirect from VPS | Hardcoded `127.0.0.1` redirect target |
| Exchange code theft | Single-use + 30s TTL + consumed atomically |
| Session theft from disk | OS keychain storage (not filesystem) |
| Cross-origin cookie leakage | SameSite + hard redirect (no cross-origin fetch) |
| Stripe tab bounce losing state | CLI params in `localStorage` (survives new tabs) |
| Setup token injection via heartbeat | State guard: only accepted during provisioning/creating, write-once |
| Exchange code expiry during recovery code save | Setup page redirects to login page for fresh code (not stale registration code) |
| Agent gate manipulation | Operator key in RAM (MCP subprocesses can't access) |
| Secret leakage in agent output | Streaming Aho-Corasick redaction engine |
| ShieldSetupFlow token delay | 90s timeout with retry button + error state |
| Parameter name mismatch (port vs callback_port) | Both accepted on VPS setup + login pages |

---

## Storage Strategy

### What goes where

| Data | Storage | Reason |
|------|---------|--------|
| Session ID | OS keychain | Sensitive credential |
| PoP private key | OS keychain | Cryptographic identity |
| Device credential | OS keychain | Long-lived trust anchor |
| Domain | `~/.ellul/config.json` | Non-sensitive, needed before keychain access |
| Proxy port + PID | `~/.ellul/proxy.port` | Process coordination, ephemeral |
| Active project | `~/.ellul/active-project` | REPL state, ephemeral |
| Project binding | `.ellul/project.json` | Per-repo, safe to commit (no secrets) |
| CLI callback params | `localStorage` | Must survive Stripe tab bounce |
| Signup tier | `sessionStorage` | Consumed on same page load |

---

## Error Recovery

### Installation fails
- `npm install -g ellul` requires Node.js >= 18
- Fallback: `npx ellul login` works without global install

### Browser doesn't open
- CLI prints the URL to stderr — user can copy/paste manually
- 5-minute timeout with descriptive error

### OAuth fails
- Console shows error, user retries from the same URL
- CLI callback server keeps waiting until timeout

### Stripe checkout cancelled
- User returns to console with `?checkout=cancelled`
- CLI callback server keeps waiting — user can retry checkout from dashboard

### VPS provisioning fails
- Dashboard shows error state
- User can retry from dashboard
- CLI callback server times out after 5 minutes

### Passkey registration fails
- Setup page shows error message with retry button
- Setup token has 1-hour TTL — user can retry

### Setup token expired
- Token has 1-hour TTL from generation
- If expired, user must re-provision (the VPS needs a fresh token)
- For existing passkey-less servers, the enforcer can regenerate via the web-locked switch script

### VPS hibernated on subsequent login
- Proxy daemon sends heartbeat to `srv.{domain}/health` every 30 seconds
- VPS wake is automatic — takes ~30 seconds
- CLI shows "Authenticated via registered device" immediately

### Device trust expired
- CLI falls back to browser login automatically
- New passkey auth generates fresh device trust
- Previous device credential preserved (not deleted on transient errors)

---

## File Reference

### New Files

| File | Purpose |
|------|---------|
| `apps/web/src/app/signup/page.tsx` | Bridge redirect: ellul.ai/signup → console.ellul.ai/sign-up |
| `apps/console/src/components/dashboard/ShieldSetupFlow.tsx` | Enterprise provisioning checklist + VPS redirect |

### Modified Files — Console

| File | Changes |
|------|---------|
| `apps/console/src/app/sign-up/page.tsx` | Product-aware signup (Shield tier detection + CLI callback params in localStorage) |
| `apps/console/src/app/dashboard/layout.tsx` | shield_proxy in auto-act checkout union + ShieldSetupFlow rendering |

### Modified Files — API

| File | Changes |
|------|---------|
| `apps/api/src/provisioning/shell/packages/crypto-keys.sh` | Setup token generation on first boot + report to API |
| `apps/api/src/routes/servers/heartbeat.routes.ts` | Parse + store `setupToken` from heartbeat |
| `apps/api/src/routes/servers/status.routes.ts` | Expose `setupToken` in server status response |

### Modified Files — VPS

| File | Changes |
|------|---------|
| `packages/vps/.../setup.routes.ts` | Exchange code in verify response + localhost callback redirect in JS |

### Modified Files — CLI (18 files)

| File | Changes |
|------|---------|
| `packages/cli/package.json` | name: `ellul`, version: `0.1.1`, bin/files/publishConfig |
| `packages/cli/src/commands/login.ts` | Config dir `~/.ellul/`, `&product=shield_proxy` in signup URL |
| `packages/cli/src/proxy-daemon.ts` | Config dir `~/.ellul/` |
| `packages/cli/src/mcp-server.ts` | Config dir `~/.ellul/`, server name `ellul` |
| `packages/cli/src/lib/context.ts` | Port file path `~/.ellul/proxy.port` |
| `packages/cli/src/repl.ts` | Active project file `~/.ellul/active-project` |
| `packages/cli/src/instructions.ts` | MCP server name `ellul`, binary `ellul-mcp` |
| `packages/cli/src/index.ts` | Header comments: `ellul CLI` |
| `packages/cli/src/lib/help.ts` | All help text: `ellul` |
| All other `src/**/*.ts` | User-facing strings: `ellul` → `ellul` |

### Database

| Column | Table | Purpose |
|--------|-------|---------|
| `sovereignSetupToken` | `servers` | One-time setup token for CLI passkey flow (already existed, now populated) |
