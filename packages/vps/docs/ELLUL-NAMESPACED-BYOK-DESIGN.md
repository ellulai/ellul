# `ellul-namespaced` — BYOK Per-Project Key Sealing

Status: **Phases 1–3 implementation in progress, Phase C session 2.**
Open questions A–H signed off (user, 2026-04-28). Phases 4 and 5 deferred.

This document closes the **M-5** finding from the Wave 0 review: BYOK API
keys (Anthropic / OpenAI / etc.) currently land in the agent's namespace
as plaintext (~/.config/zeroclaw/auth.json or equivalent), which means a
compromise of the agent process inside namespace `sbx-A` reveals every
provider key the user ever set on that project. The daemon already owns
the trust boundary; the natural next step is for it to own BYOK
ciphertexts as well, never letting plaintext sit on disk.

The aim is **provably bounded blast radius**:

> Compromise of the agent process inside namespace `sbx-A` reveals only
> the provider keys actively unwrapped during a live `ENTER` of `sbx-A`,
> for the duration of that child process. Past keys, future keys, and
> keys for any namespace `sbx-B` (B ≠ A) remain inaccessible.

---

## 1. Threat model

### Defended

A `$SVC_USER` process inside namespace `sbx-A` cannot:

1. Read a plaintext provider key from any file under its mount tree.
2. Cause the daemon to unwrap a ciphertext belonging to namespace `sbx-B`.
3. Cause the daemon to unwrap a ciphertext that was wrapped under a
   prior project secret (replay across project drop+recreate).
4. Read the daemon's master key, project subkeys, or any secretbox nonces
   while they are in the daemon's address space.
5. Cause the daemon to log plaintext keys to the event log or phase log.

### Out of scope

- A live `ENTER` exposes plaintext to the child via `environ`. Standard
  concern; the namespace + `ptrace_scope=1` boundary is the existing
  defence.
- Kernel CVEs in libsodium / kernel keyring.
- Full root compromise of the host (master key is on disk; root reads it).
- Cold boot / forensic analysis of the disk vault — encrypting at rest
  on top of LUKS is a separate work item.

---

## 2. Cryptographic primitives

| Primitive               | Library      | Use                                |
|-------------------------|--------------|------------------------------------|
| HKDF-SHA256             | libsodium    | Subkey derivation                  |
| crypto_secretbox        | libsodium    | XSalsa20-Poly1305 AEAD             |
| randombytes_buf         | libsodium    | 24-byte nonces + project secrets   |

libsodium is already linked by the daemon (manifest signature verify);
no new dependency. Constant-time comparisons throughout.

---

## 3. Key hierarchy

Three layers, each rooted in a piece of state with a different rotation
cadence and revocation surface.

```
master_secret          (provisioned once, persists; rotated rarely)
       │
       ▼
project_secret[slug]   (created at CREATE_PROJECT; destroyed at DROP_PROJECT)
       │
       ▼
subkey[slug, provider] (derived in daemon RAM, never persisted)
       │
       ▼
ciphertext             (per-key, on disk in the bridge's BYOK store)
```

### 3.1 Master secret

- 32 random bytes from `randombytes_buf`.
- Stored at `/etc/ellul/byok-master.key` (`root:root 0400`).
- Provisioned at host setup time, written **once**, persisted across
  reboots and across daemon restarts.
- Lives on the LUKS-shielded vault (same volume as `/etc/ellul`), so
  decommissioning the volume revokes every BYOK ciphertext at once.
- **Rotation policy**: see §6.1. Operator-driven, rare.
- **Open question A**: do we provision the master secret per-host at
  install, or per-tenant if multi-tenant evolves? Recommend per-host;
  multi-tenant is out of the current product scope.

### 3.2 Project secret

- 32 random bytes from `randombytes_buf`.
- Stored at `/var/lib/ellul/byok/<slug>/secret` (`root:root 0400`).
- Created when `CREATE_PROJECT` succeeds. Destroyed when `DROP_PROJECT`
  succeeds.
- The directory `<slug>/` is `root:root 0700` so a process without
  daemon-equivalent privileges cannot even `stat` the file.
- Project drop **deletes the secret** before any other teardown step;
  a partial-drop that leaves the secret behind is the expected
  failure mode (the next drop attempt completes the cleanup).
- **Rotation policy**: see §6.2. Per-project, infrequent.

The project secret is what makes drop+recreate revocation work — a
recreated project gets a fresh secret, so any ciphertext wrapped under
the prior incarnation becomes unopenable. Without this layer, drop
would not actually revoke.

### 3.3 Subkey

- 32 bytes derived in daemon RAM at the moment of wrap or unwrap.
- Derivation: `HKDF-SHA256(salt=master_secret, ikm=project_secret,
  info="ellul-byok-v1\0" || provider)`. Provider is a short ASCII
  identifier (`anthropic`, `openai`, `gemini`, etc.).
- **Never persisted.** Lives on the daemon's stack for the duration of
  a single wrap/unwrap, then `sodium_memzero`'d.
- The HKDF construction binds the subkey to BOTH the master and the
  project secret; rotating either invalidates derived subkeys.
- **Open question B**: should `info` include a manifest version /
  release tag so that a daemon upgrade automatically rotates BYOK
  subkeys? Recommend no — that couples key rotation to deploys, which
  amplifies blast radius of a bad release.

### 3.4 Ciphertext

- `nonce_24 || ciphertext_N+16` (libsodium standard layout).
- N = plaintext length, ≤ 4096 bytes (provider keys are well under
  this; reject larger).
- Stored by the bridge in its BYOK config (whatever shape it currently
  uses — wrapping replaces plaintext, structure unchanged).
- Wire format on the daemon socket: bytestring keyed in CBOR.

---

## 4. Wire protocol additions

Two new opcodes on the per-project socket. Authentication is the
standard §5 contract from the protocol document — five-gate auth +
HMAC trailer per request. No FDs cross the boundary; plaintext travels
as a sealed memfd in BYOK_UNWRAP_RESPONSE only.

### 4.1 `BYOK_WRAP` (opcode `0x60`) and response `0x61`

Request CBOR keys (after the standard `request_id` + `nonce`):

| Key | Field            | Type            | Notes                              |
|-----|------------------|-----------------|------------------------------------|
| `3` | provider         | text ≤ 32       | matches `^[a-z][a-z0-9-]{0,31}$`   |
| `4` | plaintext_memfd  | uint == `0xFD00`| sentinel; sealed memfd in cmsg     |

Ancillary: one fd, a sealed memfd (F_SEAL_WRITE|F_SEAL_GROW|F_SEAL_SHRINK)
containing the plaintext key bytes (no terminator, no whitespace).

Response keys:

| Key | Field         | Type        |
|-----|---------------|-------------|
| `1` | request_id    | uint        |
| `2` | success       | bool        |
| `3` | wrapped       | bstr ≤ 4 KiB|

`wrapped` is `nonce_24 || ciphertext`. The bridge stores it verbatim;
daemon does not retain a copy.

### 4.2 `BYOK_UNWRAP` (opcode `0x62`) and response `0x63`

Request keys:

| Key | Field         | Type            |
|-----|---------------|-----------------|
| `3` | provider      | text ≤ 32       |
| `4` | wrapped       | bstr ≤ 4 KiB    |

Response keys:

| Key | Field            | Type             | Notes                         |
|-----|------------------|------------------|-------------------------------|
| `1` | request_id       | uint             |                               |
| `2` | success          | bool             |                               |
| `3` | plaintext_memfd  | uint == `0xFD00` | sentinel; sealed memfd in cmsg|

Daemon unwraps in RAM, writes plaintext to a fresh `memfd_create`,
applies `F_SEAL_WRITE|F_SEAL_GROW|F_SEAL_SHRINK`, sends via SCM_RIGHTS,
and immediately closes its own copy of the memfd + zeroes the plaintext
buffer.

### 4.3 ENTER integration (opt-in)

The simplest UX: the bridge submits ciphertexts in the env memfd with a
prefix marker, and the daemon unwraps them inline before exec. Concrete
shape:

```
ANTHROPIC_API_KEY=__byok-v1:anthropic:<base64-wrapped>
OPENAI_API_KEY=__byok-v1:openai:<base64-wrapped>
PATH=/usr/bin:/bin
```

The daemon's existing env validator (enter.c::env_entry_ok) gets a new
branch: if the value starts with `__byok-v1:`, parse as
`__byok-v1:<provider>:<base64-wrapped>`, unwrap with the project's
subkey, and substitute the plaintext into the env passed to execve.

This keeps the bridge's spawn surface unchanged — bridge calls
`spawnInNamespace` with an env where every BYOK is a `__byok-v1:…`
sentinel; the daemon takes care of unwrapping.

**Open question C**: should the env-prefix marker be `__byok-v1:` or
something less collision-prone? Any marker we pick is implicitly part
of the wire protocol once a single ciphertext lands on disk under it.
Recommend keeping the marker short and version-tagged (`v1`); the
daemon rejects any BYOK env entry whose marker version it doesn't
support.

---

## 5. Bridge changes (sketch)

The bridge already has a BYOK store somewhere in `agent-bridge`'s
config layer. Phase C implementation work:

1. At "user adds a BYOK key" UX flow, instead of writing plaintext to
   the project config, bridge connects to the per-project socket,
   sends `BYOK_WRAP` with the plaintext memfd, stores the returned
   ciphertext.
2. At spawn time, the bridge replaces every plaintext provider key in
   the env passed to `spawnInNamespace` with `__byok-v1:<provider>:<b64>`.
   Daemon-routed ENTER unwraps before exec; legacy sudo path sees the
   ciphertext as opaque (provider keys won't work on the legacy
   path — operators must turn on `nsd-cutover-enter` before BYOK
   rolls out, see §7).
3. Bridge surfaces a "rewrap-all" path operators run after master-key
   or project-secret rotation.

No on-disk plaintext key ever transits the bridge after this lands.

---

## 6. Rotation

### 6.1 Master rotation

Heavy-handed, fleet-wide. Steps:

1. Generate `master_secret_new`, store at `/etc/ellul/byok-master.key.new`.
2. Bridge reads every existing ciphertext, calls a daemon RPC
   `BYOK_REWRAP` (provided as a future opcode `0x64`) which decrypts
   under old master and re-encrypts under new master atomically.
   Daemon supports both keys for the duration of rewrap.
3. After bridge confirms every ciphertext rewrapped, daemon swaps:
   `mv byok-master.key.new byok-master.key`, drops the old key from
   memory, refuses any further old-master decrypt.

**Open question D**: do we need atomic rewrap (daemon supports both
masters simultaneously)? Or is "downtime window during rotation"
acceptable? Recommend atomic — the daemon-protocol surface is small,
adding the dual-key state is local to the byok module.

### 6.2 Per-project rotation

Cheap, project-local. Two paths:

- **Implicit**: `DROP_PROJECT` followed by `CREATE_PROJECT` with the
  same slug yields a new project secret. Any prior ciphertext is
  unopenable. The bridge MUST re-wrap on first use (it discovers
  unwrap fails, prompts the user to re-paste, or fails the spawn —
  see §8).
- **Explicit**: an opcode `BYOK_REKEY_PROJECT` that rotates the
  project secret without affecting the slug or any other state.
  Useful for "user thinks a key may have leaked, wants a fresh
  wrapping context".

**Open question E**: ship explicit `BYOK_REKEY_PROJECT` in v1 or
defer? Recommend defer — the implicit drop+recreate path is
already provided by the project lifecycle, and explicit rekey adds
one more state machine.

---

## 7. Revocation

Revocation guarantees, ranked from cheap to nuclear:

1. **Single key**: bridge deletes the ciphertext. Trivial, no daemon
   action needed.
2. **Single project, all keys**: `DROP_PROJECT`. Daemon unlinks
   `/var/lib/ellul/byok/<slug>/secret`. Every ciphertext that was
   wrapped under that project is now unopenable; the underlying
   bytes are still on the bridge's disk but cryptographically
   useless.
3. **Single project, fresh wrapping context**: `BYOK_REKEY_PROJECT`
   (open question E).
4. **Whole fleet**: master rotation (§6.1). Heavy but provides a
   clean break.
5. **Volume decommission**: destroy the LUKS-shielded volume.
   `byok-master.key` and every `project_secret` are gone in a single
   atomic step.

The lifecycle order at DROP_PROJECT matters:

```
DROP_PROJECT(slug):
  1. unlink /var/lib/ellul/byok/<slug>/secret
  2. rmdir  /var/lib/ellul/byok/<slug>/
  3. existing teardown work (sockets, anchor, …)
```

If step 1 succeeds and 3 fails, the daemon retries 3 — but step 1's
revocation is already complete. The reverse order would leave a
window where an attacker who races teardown could re-derive the
subkey.

---

## 8. Failure modes

| Failure                                | Daemon behaviour                              | Bridge surface                                    |
|----------------------------------------|-----------------------------------------------|---------------------------------------------------|
| `byok-master.key` missing at startup   | Refuse to start (exit 78, like manifest)      | Provisioning bug; alarm                           |
| project secret missing at WRAP         | Return errcode `EBYOK_NO_PROJECT_SECRET`      | Surface as "BYOK not provisioned for this project"|
| project secret missing at UNWRAP       | Same                                          | Surface as "BYOK key invalid; re-wrap needed"     |
| ciphertext fails Poly1305 MAC          | Return `EBYOK_BAD_MAC`                        | Surface as "BYOK key tampered or master rotated"  |
| plaintext memfd not properly sealed    | Return `EFD_KIND` (existing code)             | Bug in bridge; alarm                              |
| Daemon crash between WRAP and storage  | n/a (operation atomic to bridge: it commits   | Bridge retries WRAP; idempotent                   |
|                                        | the ciphertext only after success response)   |                                                   |
| Master rotation + race with WRAP       | New master generates ciphertexts old daemon   | Bridge must drain in-flight WRAPs before rotation |
|                                        | cannot read; vice-versa                       | starts (operator-controlled)                      |

No silent-success failure modes — everything either succeeds with the
expected response or returns a specific errcode.

**Open question F**: do we need a daemon-side audit of *successful*
unwraps? Recommend a single counter (per project) emitted as
`nsd.byok.unwrap.ok` with `count` field, NOT per-call (per-call would
be a useful information-flow channel for an attacker who can read the
event log). The provider field is logged in WRAP failures, not
successes.

---

## 9. Phased rollout

The implementation does not need to be one shot.

| Phase | Scope                                                       | Trigger                              |
|-------|-------------------------------------------------------------|--------------------------------------|
| 1     | `byok-master.key` provisioning, project-secret lifecycle    | This design signed off               |
| 2     | `BYOK_WRAP` + `BYOK_UNWRAP` opcodes; bridge wrap UX         | Phase 1 telemetry shows secrets stable|
| 3     | ENTER inline unwrap (`__byok-v1:` env marker)               | Phase 2 wrap/unwrap stable on canary |
| 4     | `BYOK_REWRAP` for master rotation                           | First rotation event needed          |
| 5     | `BYOK_REKEY_PROJECT` (open question E)                      | Operator demand                      |

Each phase is independently flag-gated: `nsd-byok-wrap-enabled`,
`nsd-byok-unwrap-enabled`, `nsd-byok-enter-inline-enabled`.
"No fallbacks" semantics — when a flag is set, the daemon is
mandatory; when unset, the bridge stores plaintext (current
behaviour).

---

## 10. Open questions — signed off (2026-04-28)

All eight resolved by user sign-off; recorded here as the durable
contract the implementation enforces.

- **A**: per-host master. **APPROVED.** `/etc/ellul/byok-master.key` is
  provisioned per-host at install time. Multi-tenant (per-tenant master)
  is out of current product scope; revisit when fleet topology demands it.
- **B**: bind subkey to manifest version. **NO.** Coupling key rotation
  to deploys amplifies blast radius of a bad release. `info` string is
  fixed at `"ellul-byok-v1\0" || provider` — daemon upgrades do NOT
  rotate subkeys. Explicit master / project-secret rotation is the
  rotation surface (§6).
- **C**: env-prefix marker shape. **`__byok-v1:` short marker.** Once a
  ciphertext lands on disk under this marker it is implicitly part of
  the wire protocol; the version tag (`v1`) lets a future daemon reject
  unknown marker versions cleanly.
- **D**: dual-master atomic rewrap. **YES.** Daemon supports both old
  and new master simultaneously during rewrap so the bridge can drain
  in-flight WRAPs without a downtime window. Adds local state to the
  byok module (~30 lines C) — worth the operational simplicity.
  Deferred to Phase 4 (`BYOK_REWRAP`).
- **E**: explicit `BYOK_REKEY_PROJECT`. **DEFERRED.** Implicit drop+
  recreate already provides project-local rotation via the project
  lifecycle. Add explicit rekey only if operator demand surfaces; one
  fewer state machine to maintain in v1.
- **F**: per-call unwrap audit. **Per-project counter only.** Single
  `nsd.byok.unwrap.ok` event per project per session window with `count`
  field. Per-call would be a useful info-flow channel for an attacker
  who can read the event log.
- **G**: bridge BYOK store schema. **Keep current shape; swap plaintext
  for ciphertext.** Avoids a parallel schema migration. The
  `__byok-v1:<provider>:<b64>` marker is self-describing — the bridge
  knows from the prefix that the value is wrapped.
- **H**: bridge UX on `EBYOK_NO_PROJECT_SECRET`. **Surface "BYOK keys
  lost — re-enter on next session" in project settings.** NEVER
  auto-regenerate; that would silently drop the user's keys after a
  drop+recreate without their knowledge.

Implementation budget after sign-off: daemon side ~600 lines C across
`byok.{c,h}` plus integration in `enter.c` and `ops.c`; bridge side
~200 lines TS in the BYOK store.

---

## 11. Out of scope for this strawman

- Encrypting BYOK ciphertexts on top of the existing LUKS shielded
  vault (defence in depth; separate work item).
- Cross-project key sharing (currently disallowed by design).
- Rotation of `/etc/machine-id` (out of scope; treat as immutable
  per host lifecycle).
- A standalone `BYOK` CLI for operators to inspect / rotate
  (operationally useful, separate work item).
