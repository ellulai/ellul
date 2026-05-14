# `ellul-namespaced` Wire Protocol — v1

Status: **Wave 1 Phase A**. Setup/Teardown/Create/Drop active; Enter/Spawn/InjectEnv
deferred to a later phase (need async-child + memfd-FD-passing infra). Decisions
A–F (§14) are locked. Implementation lands in this commit.

This document defines the on-the-wire contract between `agent-bridge` (untrusted-ish
peer running as `$SVC_USER` inside `ellul-control-plane.slice`) and `ellul-namespaced`
(privileged daemon running as `root` outside any namespace). It supersedes the
sudo-into-bash control plane in `/usr/local/bin/ellul-agent-namespace` *for the
operations listed below*; the bash path remains untouched in Wave 0 and is cut over
in Wave 1.

The protocol's load-bearing security claim is:

> No message accepted by the daemon can cause it to operate on a project other
> than the one whose socket the message arrived on, and no message can cause the
> daemon to read or write a path supplied by the peer.

Section [Self-review](#13-self-review-cross-project--path-supply) walks each message
type to demonstrate this.

---

## 1. Threat model

### Defended (must hold)

A `$SVC_USER` process inside namespace `sbx-A` cannot:

1. Cause the daemon to setup, enter, spawn, attest, inject env into, or teardown
   namespace `sbx-B` for any `B ≠ A`.
2. Cause the daemon to read or write a host filesystem path it controls.
3. Forge a request that passes auth without being inside `agent-bridge.service`'s
   cgroup (kernel-enforced via `SO_PEERPIDFD` + `/proc/<pidfd>/cgroup`).
4. Replay a captured message (bound to a one-time `request_id` and the peer's
   `pidfd` inode).
5. Tamper with the manifest the daemon attests against (Ed25519-signed by a key
   the bridge cannot read).
6. Cause the daemon itself to escape its mount/PID/network namespace, load
   kernel modules, or call dangerous syscalls (own seccomp filter; matches the
   one we install inside agent namespaces, plus a few daemon-only allowances).

### Out of scope

- Kernel CVEs (we assume a non-vulnerable Linux 6.5+).
- Compromise of `agent-bridge`'s memory: such an attacker has the per-server
  HMAC key and can act as the bridge identity. The cross-project containment
  guarantee still holds because the daemon never derives project identity from
  the bridge's claims; project identity comes from kernel-enforced socket
  paths.
- Compromise of the manifest-signing key — the **private key never lives on
  the VPS**. Manifests are signed at build time on the API/build host
  (`apps/api`); only the 32-byte public key ships to VPS at provisioning, at
  `/etc/ellul/manifests/manifest.pub` (`root:root 0444`). Compromising a VPS
  cannot forge a manifest.

---

## 2. Kernel floor and platform

| Feature                          | First kernel | Used for                                         |
|----------------------------------|--------------|--------------------------------------------------|
| `SO_PEERCRED`                    | 2.6.x        | Coarse peer identity (uid/gid/pid)               |
| `SO_PEERPIDFD`                   | **6.5**      | Race-free peer pidfd (defeats PID reuse)         |
| `pidfd_send_signal(0)`           | 5.1          | Pidfd liveness probe                             |
| `openat2(RESOLVE_NO_SYMLINKS)`   | 5.6          | Path-free file ops within a trusted root FD     |
| `fsopen` / `fsmount` / `move_mount` | 5.2       | New-mount-API path-free mount staging            |
| `clone3(CLONE_PIDFD\|CLONE_INTO_CGROUP)` | 5.7  | Cgroup-pinned anchor spawn (Wave 1)              |
| `mount_setattr`                  | 5.12         | Idempotent recursive RO/private remounts        |
| `STATX_MNT_ID`                   | 5.8          | Mount-id-based attestation                       |

Ubuntu 24.04 LTS ships kernel 6.8 by default. **The kernel floor is 6.5,
hard-required**: every feature in the table is a load-bearing primitive of the
auth or mount paths. The daemon probes for `SO_PEERPIDFD` at startup (§7.5)
and refuses to start if missing — there is no fallback path. A host
running an older kernel is a provisioning bug; we want it to fail loudly.

---

## 3. Topology

### 3.1 Sockets

| Path                                 | Owner / mode        | Purpose                                  |
|--------------------------------------|---------------------|------------------------------------------|
| `/run/ellul-ns/admin.sock`           | `root:ellul-ns 0660`| Lifecycle: create_project / drop_project, RECONCILE, host-level health, manifest pubkey export. |
| `/run/ellul-ns/<project>/ctl.sock`   | `root:ellul-ns 0660`| Per-project: ATTEST (Wave 0), HEALTH; SETUP / ENTER / SPAWN / INJECT_ENV / TEARDOWN (Wave 1). |

Both paths live on `tmpfs` (`/run`). The daemon `bind()`s the listening sockets
itself (no systemd socket activation — see §3.4 for why). The per-project
directory `/run/ellul-ns/<project>/` is `root:root 0700` so a process without
the `ellul-ns` group can't even `stat()` the socket inode.

### 3.2 Group provisioning

A single system group `ellul-ns` (GID assigned at install time) owns every
per-project and admin socket. `agent-bridge.service` has
`SupplementaryGroups=ellul-ns` from first install; project add/drop requires
no bridge restart.

The single shared group is **defense in depth, not the load-bearing gate**.
The actual gate at accept time is the §5 cgroup check: a process must live in
`ellul-agent-bridge.service`'s cgroup to pass auth. Even a process that
inherits the `ellul-ns` GID from a fork (e.g. a misbehaving child of
agent-bridge that escaped the cgroup) fails auth at message dispatch.
Per-project group churn is rejected on operational grounds: per the current
release pipeline, every bridge restart drops live WebSockets.

### 3.3 Daemon socket lifecycle

The daemon owns socket creation and destruction.

- **Boot path.** At startup, daemon mkdirs `/run/ellul-ns/` (mode 0750
  `root:ellul-ns`), binds `admin.sock`, scans `/run/.ns-*/anchor.pid` for
  surviving namespaces from a previous daemon run, and binds a per-project
  socket for each one whose anchor PID is still alive and is in the
  `ellul-namespaces.slice/ellul-ns-<project>.service` cgroup.
- **CREATE_PROJECT.** Daemon `mkdir`s `/run/ellul-ns/<project>/` (mode 0700
  `root:root`), `bind()`s `ctl.sock`, `chmod 0660`, `chown root:ellul-ns`. The
  ordering — mkdir-then-bind-then-chmod-then-chown — keeps the socket
  inaccessible during creation; an attacker racing `create_project` cannot
  observe a partially-permissioned socket.
- **DROP_PROJECT.** Close listening fd, `unlink ctl.sock`, `rmdir
  /run/ellul-ns/<project>/`. Pre-existing connections die when the daemon
  closes them.

### 3.4 Daemon process

### 3.4 Daemon systemd unit

```
[Unit]
Description=ellul Namespaced Daemon
After=local-fs.target ellul-luks-boot.service
Before=ellul-agent-bridge.service
RequiresMountsFor=/etc/ellul /opt/ellul
ConditionPathExists=/etc/ellul/feature-flags/nsd-enabled

[Service]
Type=notify
User=root  Group=root
NotifyAccess=main
ExecStart=/usr/local/bin/ellul-namespaced
Restart=on-failure  RestartSec=2
SuccessExitStatus=78                        # EX_CONFIG: kernel-too-old; do NOT restart
WatchdogSec=15

LimitCORE=0  LockPersonality=true
NoNewPrivileges=true                        # daemon never execs setuid binaries
ProtectSystem=strict
ReadWritePaths=/run/ellul-ns /var/log/ellul /run
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=false                  # MUST read /proc/<pid>/cgroup of peers
RestrictAddressFamilies=AF_UNIX
RestrictNamespaces=mnt pid net
SystemCallArchitectures=native
MemoryDenyWriteExecute=true
RestrictRealtime=true
RestrictSUIDSGID=true
CapabilityBoundingSet=CAP_SYS_ADMIN CAP_NET_ADMIN CAP_SETUID CAP_SETGID CAP_DAC_OVERRIDE CAP_CHOWN CAP_SYS_PTRACE
AmbientCapabilities=
OOMScoreAdjust=-900
Slice=ellul-control-plane.slice
TasksMax=64
MemoryMax=128M
```

`AmbientCapabilities=` is empty — the daemon runs as root, so the bounding set
constrains caps but no ambient caps are needed. `CAP_SYS_ADMIN` + `CAP_NET_ADMIN`
together let the daemon `setns()` and `mount()` (Wave 1).
`CAP_SYS_PTRACE` is required because Yama `kernel.yama.ptrace_scope=1` is set
on the fleet (per memory: "ptrace_scope=1: kernel blocks agent from reading
/proc/<pid>/environ of shield's git subprocesses (siblings, not parent-child)");
without `CAP_SYS_PTRACE` the daemon can't `setns()` into a namespace owned by
a process the daemon didn't fork. Wave 0 only uses it for `pidfd_send_signal(0)`
liveness; Wave 1 needs it for `setns()` into anchor mount NS during INJECT_ENV.

`NoNewPrivileges=true` is safe because the daemon never `execve()`s setuid
binaries. The Wave 1 cutover spawns helpers via `setns()` + `setresuid()` +
`execve(/usr/bin/<binary>)`; setuid bits aren't honored, which is what we want.

`Type=notify` + `WatchdogSec=15`: the daemon `sd_notify(WATCHDOG=1)` from its
main loop every 5s. A wedged daemon (deadlock, infinite loop in a handler)
gets killed and restarted by systemd within 15s. Connections in flight are
abandoned; bridge retries.

### 3.5 Why `User=root` and not a system user with ambient caps

Ambient `CAP_SYS_ADMIN` + `CAP_NET_ADMIN` + `CAP_SETUID` is functionally
indistinguishable from root for this workload — there is no security boundary
gained by running under UID 999 with those caps. Running as root and locking
the daemon down via systemd is the documented systemd model
(`systemd.exec(5)`'s `User=` notes) and matches how `ellul-luks-boot` and
`ellul-warden` are deployed today.

---

## 4. Wire format

### 4.1 Framing

Every message is `u32 length-be || frame`. `length` excludes its own 4
bytes. Maximum frame size is **64 KiB**; oversize frames close the connection
with `EPROTO`. Multi-message conversations on a single socket are sequential
half-duplex (request/response); the daemon never sends unsolicited messages
except `HELLO` at connect.

**Request frames** carry an HMAC trailer:

```
[opcode (1 byte)] [CBOR map] [HMAC trailer (16 bytes)]
```

The HMAC covers `frame[0 .. flen - 16]` — opcode + CBOR map. Putting the
HMAC outside the CBOR body avoids the self-reference trap (HMAC depending
on bytes that include the HMAC).

**Response frames** are unauth'd: `[opcode] [CBOR map]`. The connection is
already authenticated by the client's request HMACs; daemon → client is
implicitly trusted on the same connection.

### 4.2 CBOR profile

- Use **definite-length** maps and arrays only; indefinite-length is rejected.
- Map keys are **u8** integers (not strings). Each message defines its key
  table; there is no schema fallback.
- All strings are UTF-8, max 4 KiB unless noted.
- Bytestrings are byte-exact; no canonicalization is applied.
- An **unknown map key** in a request is a hard reject (`EPROTO`). This is
  deliberately strict: forward-compat is via explicit version bumps, not via
  silent key-skipping. Wave 0 emits log warnings rather than rejects when a
  feature flag is set; production rejects.

CBOR library: `tinycbor` (Intel, MIT-licensed, `libtinycbor-dev` on Ubuntu
24.04). **Checkpoint C** chooses between the apt package and vendoring a
trimmed copy of `tinycbor.c` + `tinycbor.h` under
`packages/vps/src/shell/helpers/ellul-namespaced/vendor/`. Apt is the default
recommendation; vendoring is a hedge against repo unavailability during
provisioning.

### 4.3 SCM_RIGHTS conventions

When a message passes file descriptors:

- The CBOR body contains a `fds` array with **sentinel values**
  (`0xFD00 .. 0xFD0F`) marking the slots; the actual fds arrive in the
  recvmsg(2) ancillary data and are matched positionally to the sentinels.
- The daemon `dup3()`s every received fd with `O_CLOEXEC` set unconditionally
  before processing.
- The daemon checks `fstatat(fd, "", AT_EMPTY_PATH)` for every received fd and
  rejects fds whose `st_mode` doesn't match the expected kind for that
  message slot (e.g. an INJECT_ENV memfd that's actually a regular file
  on a host path → reject).

---

## 5. Authentication contract

Every per-project socket connection passes **all five** of these gates before
the daemon dispatches the first non-HELLO message:

1. **`SO_PEERCRED`** — peer uid must be `$SVC_USER`'s uid as recorded at daemon
   startup (read from `/etc/default/ellul`).
2. **`SO_PEERPIDFD`** — kernel returns a pidfd that pins the peer's task
   identity; PID reuse can no longer make this valid for a different process.
3. **Cgroup check** — daemon opens `/proc/self/fd/<peer_pidfd>/cgroup` via
   `openat()` rooted on the pidfd (kernel resolves to the peer's procfs entry
   atomically; PID reuse is impossible because the pidfd pins the task).
   Required path shape:
   `0::/ellul.slice/ellul-control.slice/ellul-control-plane.slice/ellul-agent-bridge.service`
   (CgroupHygieneAssertion enforces the same shape from the bridge's side;
   the daemon mirrors it). Anything else: deny.
4. **Manifest pubkey continuity** — the bridge must provide a server-key
   fingerprint in `CLIENT_HELLO` matching the daemon's current attestation
   pubkey. A mismatch indicates either daemon restart with a new key (bridge
   should reconnect and re-fetch) or a man-in-the-middle situation.
5. **HMAC session establishment** — bridge must demonstrate possession of the
   shared HMAC key by signing `(server_nonce || client_nonce || client_id_hint)`
   in `CLIENT_HELLO`. The shared key lives at
   `/etc/ellul/nsd-hmac.key` (`root:ellul-ns-admin 0640`, 32 random bytes,
   provisioned at install time by `apps/api/src/provisioning`).

After `CLIENT_HELLO`, the session has:

- `session_id` (16 bytes, daemon-chosen, used as additional HMAC input)
- `peer_pidfd_inode` (the inode of the SO_PEERPIDFD fd, read by the daemon
  via `fstat`; bridge cannot fake this since it doesn't get the pidfd)

Per-request HMAC scope:

```
hmac_input = session_id || request_id_be8 || nonce16 || peer_pidfd_inode_be8
                        || cbor_body_digest_sha256
hmac_tag   = HMAC-SHA256(shared_key, hmac_input)  // truncated to 16 bytes
```

`request_id` is monotonic per session; the daemon rejects requests with
`request_id <= last_seen` for that session (replay defence). `nonce16` is
fresh per request. `peer_pidfd_inode` ties the request to the *exact* pidfd
the daemon authenticated; if the bridge restarts and reconnects, the inode
changes and old captured frames cannot be replayed against the new session.

---

## 6. Manifest schema

Manifests are CBOR-encoded and Ed25519-signed. The **private signing key never
lives on a VPS**: manifests are signed at API/build time by the same key
material `apps/api` already uses for entitlement signing (see §6.3). Only the
32-byte Ed25519 public key ships to the VPS, at
`/etc/ellul/manifests/manifest.pub` (`root:root 0444`).

A manifest is **tier-keyed, not project-keyed**: one signed blob covers every
project at a given tier. The daemon verifies the signature once, validates
the manifest's `applies_to_tier` matches the host's tier file, and reuses
the parsed result across all per-project ATTEST calls. No per-project signing
ceremony is needed; provisioning ships `free.cbor` and `paid.cbor` with
`/opt/ellul/manifests/`.

### 6.1 Top-level CBOR schema

| Key  | Name              | Type           | Notes                                              |
|------|-------------------|----------------|----------------------------------------------------|
| `1`  | manifest_version  | uint           | currently `1`; bumped on field shape change        |
| `2`  | issued_at_unix_s  | uint           | wall-clock at signing (seconds)                    |
| `3`  | not_after_unix_s  | uint           | manifests expire (default `issued_at + 30d`)       |
| `4`  | applies_to_tier   | text           | `free` \| `paid`; matched against `/etc/ellul/billing-tier`     |
| `5`  | project_slug_re   | text           | regex; project derived from socket must match (default `^sbx-[a-z0-9]{7}$`) |
| `6`  | mounts            | array of mount | see §6.2                                           |
| `7`  | network           | map            | iptables/ipset shape; opaque to attestation today  |
| `8`  | binaries_digest   | bstr 32        | sha256 over canonical concat of `(/usr/local/bin/ellul-ns-mount, ellul-seccomp-exec, ellul-namespaced)`; pinning binaries to manifest |
| `9`  | host_id_re        | text           | regex; matched against `/etc/ellul-bootstrap/server-id`. Use `.*` for fleet-wide; tighter regex for per-host pinning |
| `10` | sig               | bstr 64        | Ed25519 signature over CBOR(map without key 10)    |

Daemon verifies in this order on first load:
`10` (sig) → `1` (version) → `3` (expiry) → `4` (tier) → `9` (host_id_re).
On every ATTEST call: `5` (slug regex against socket-derived project) →
binaries_digest (against on-disk binaries) → mount walk.

### 6.2 Mount entry

| Key  | Name              | Type            | Notes                                           |
|------|-------------------|-----------------|-------------------------------------------------|
| `1`  | target_template   | text            | path with `{project}` and `{home}` placeholders, daemon-substituted; no `..`; no shell metas |
| `2`  | kind              | enum (uint)     | `1=bind` `2=tmpfs` `3=overlay` `4=proc` `5=blackhole` `6=ro_remount` |
| `3`  | source_template   | text \| null    | path template (or `null` for tmpfs/proc)        |
| `4`  | mandatory         | bool            | if true, attest fails if missing                |
| `5`  | post_check_fstype | text \| null    | expected fstype in `/proc/mountinfo`            |
| `6`  | flags             | uint            | bitwise: 1=RO, 2=NOSUID, 4=NODEV, 8=NOEXEC, 16=EMPTY (blackhole) |
| `7`  | options_required  | array of text   | substrings that must appear in mount options    |

Templates are substituted by the daemon using values it controls
(`socket-derived project slug` and `/home/$SVC_USER`). The bridge cannot
inject `{project}` substitutions because the manifest is signed; bridge
cannot edit the manifest.

Mount kinds and attestation rules:

- **bind**: source after template substitution must match the observed source
  in `/proc/mountinfo`; fstype must match.
- **tmpfs**: target is tmpfs; with `EMPTY` flag, the directory listing returns
  zero entries (`getdents` returns 0 after `.`/`..`).
- **overlay**: target is `overlay` fstype with the expected upperdir/lowerdir
  prefix path under the project's scratch dir.
- **proc**: target is `proc` fstype; `hidepid=2` option present.
- **blackhole**: tmpfs with `size=0`, mode `000`, dirent count 0.
- **ro_remount**: mount options include `ro`.

### 6.3 Manifest signing pipeline

- Build-time: `apps/api/scripts/sign-manifests.ts` (added in this commit) reads
  `packages/vps/src/manifests/free.cbor.in` + `paid.cbor.in`, signs them with
  the API's existing entitlement key (already used for offline-signed
  capabilities), writes signed bytes to
  `packages/vps/src/manifests/{free,paid}.cbor`. The plaintext templates are
  authored by hand; the signed outputs are checked into the repo (reproducible).
- Provisioning-time: `apps/api/src/provisioning/payload.ts` writes the signed
  bytes to `/opt/ellul/manifests/{free,paid}.cbor` and the public key to
  `/etc/ellul/manifests/manifest.pub`. No private key ever lands on a VPS.
- Daemon load: at startup the daemon reads the manifest matching
  `/etc/ellul/billing-tier`, verifies the signature once, caches the parsed
  result. ATTEST handlers operate on the cached parse — there is no
  per-request signature verify.

---

## 7. Message reference

All message map keys below are u8.

### 7.1 `HELLO` (server → client, opcode `0x01`)

| Key | Field                       | Type             |
|-----|-----------------------------|------------------|
| `1` | protocol_version            | uint (== 1)      |
| `2` | server_nonce                | bstr 16          |
| `3` | manifest_pubkey_fingerprint | bstr 32          |
| `4` | session_id                  | bstr 16          |
| `5` | features                    | uint (bitfield)  |
| `6` | peer_pidfd_inode            | uint (be8)       |

Sent unsolicited within 100ms of accept(). No FDs. `peer_pidfd_inode` is
the daemon-side `fstat(SO_PEERPIDFD).st_ino` for the bridge's connection
— echoed so the bridge can mix the same inode into per-message HMACs (see
§5). The bridge cannot observe this from its side; the daemon is the only
end that sees it.

### 7.2 `CLIENT_HELLO` (client → server, opcode `0x02`)

| Key | Field                       | Type             |
|-----|-----------------------------|------------------|
| `1` | protocol_version            | uint (== 1)      |
| `2` | client_nonce                | bstr 16          |
| `3` | client_id_hint              | text ≤ 64        |
| `4` | manifest_pubkey_fingerprint | bstr 32          |
| `5` | session_hmac                | bstr 16          |

The session HMAC binds `(server_nonce || client_nonce || client_id_hint)`. On
acceptance the daemon emits `nsd.session.open`; on rejection it closes the
socket.

### 7.3 `HEALTH` (client → server, opcode `0x10`) and response `0x11`

Request: empty map (auth still required). Response keys:

| Key | Field                       | Type             |
|-----|-----------------------------|------------------|
| `1` | ok                          | bool             |
| `2` | uptime_ms                   | uint             |
| `3` | manifest_pubkey_fingerprint | bstr 32          |
| `4` | features                    | uint             |
| `5` | wave                        | uint (`0` or `1`)|

Wave 0 daemon advertises `wave=0`; bridge uses this to decide whether to issue
write messages.

### 7.4 `ATTEST` (client → server, opcode `0x20`) and response `0x21`

Bridge has already created the namespace via the legacy path. Bridge passes
the anchor pidfd via SCM_RIGHTS and the signed manifest in the body.

Wave-0 simplification: the bridge sends only `request_id` + `nonce` in the
CBOR body. The daemon resolves the anchor PID itself by reading the
root-owned file `/run/.ns-<project>/anchor.pid` (`fstat`-validated to be
regular root-owned mode-0644 file before opening). The anchor pidfd is
opened daemon-side via `pidfd_open`; no FD passing in Wave 0.

Request CBOR keys:

| Key | Field                | Type                  |
|-----|----------------------|-----------------------|
| `1` | request_id           | uint                  |
| `2` | nonce                | bstr 16               |

Followed by the 16-byte HMAC trailer (§4.1).

Daemon flow:

1. Verify auth gates (§5) and per-message HMAC.
2. Confirm cached manifest's `project_slug_re` matches the socket-derived
   project name.
3. `open(/run/.ns-<project>/anchor.pid, O_NOFOLLOW)` and `fstat` —
   reject unless regular file, root-owned, no group/other write. Read
   the PID.
4. `pidfd_open(anchor_pid, 0)` and `pidfd_send_signal(pidfd, 0, NULL, 0)`
   to confirm liveness.
5. Open `/proc/self/fd/<anchor_pidfd>/cgroup` (kernel resolves through
   the pidfd target atomically) and confirm the path contains
   `/ellul-namespaces.slice/ellul-ns-<project>.service` as a path
   component. Rejects an attacker who arranged for `anchor.pid` to point
   at an unrelated process.
6. `fork()` a worker. Worker calls `setns(pidfd, CLONE_NEWNS)` to join
   the anchor's mount NS, reads `/proc/self/mountinfo`, walks the
   manifest, writes a fixed-shape result via pipe, `_exit(0)`.
7. Parent reads pipe, reaps worker, builds response, emits
   `nsd.attest.{ok|mismatch|unreachable}`.

Daemon must **not** call `setns(CLONE_NEWMNT)` on its main thread; that
would strand its own root FDs. Wave 0 forks a worker; thread-based setns
is blocked by the kernel for shared-fs pthread peers.

Response keys:

| Key | Field             | Type                                              |
|-----|-------------------|---------------------------------------------------|
| `1` | request_id        | uint (echo)                                       |
| `2` | matches           | bool                                              |
| `3` | mismatches        | array of `{target, expected, observed}`           |
| `4` | mountinfo_digest  | bstr 32                                           |
| `5` | anchor_alive      | bool                                              |
| `6` | error             | text \| null                                      |

### 7.5 Startup kernel-feature probe

There is no fallback for missing kernel features. At startup the daemon
creates a `socketpair(AF_UNIX)` and calls `getsockopt(SO_PEERPIDFD)` against
it. `ENOPROTOOPT` (or `EINVAL` on a kernel that simply lacks the option)
exits the daemon with status 78 (`EX_CONFIG`) and emits
`nsd.startup.kernel-too-old` to the phase log before exiting. The systemd
unit's `Restart=on-failure` does not retry on exit 78 (we mark it
`SuccessExitStatus=78` to make systemd treat it as configuration-fatal,
not a crash worth restarting).

Provisioning's existing kernel-version pinning makes this branch unreachable
on a healthy fleet; the probe is the trip-wire that turns a misprovisioned
host into a clear startup failure rather than a silently weakened auth path.

### 7.6 `SETUP` (client → server, opcode `0x30`) — Wave 1 only

Request keys:

| Key | Field                | Type                                     |
|-----|----------------------|------------------------------------------|
| `1` | request_id           | uint                                     |
| `2` | nonce                | bstr 16                                  |
| `3` | manifest_cbor        | bstr ≤ 32 KiB                            |
| `4` | network_cbor         | bstr ≤ 16 KiB (iptables/ipset directives)|
| `5` | shared_projects      | array of `sbx-` slugs                    |
| `6` | preview_ports        | array of u16                             |
| `7` | hmac                 | bstr 16                                  |

No FDs. Daemon stages the namespace (§8 two-phase commit) and returns
`SETUP_RESPONSE` with a `staging_id`. `ACTIVATE` (`0x31`) confirms.

In Wave 0, the daemon **logs and rejects** with `error="wave=0 read-only"`.

### 7.7 `ENTER` (client → server, opcode `0x40`) — Wave 1 only

Request keys:

| Key | Field                | Type                             |
|-----|----------------------|----------------------------------|
| `1` | request_id           | uint                             |
| `2` | nonce                | bstr 16                          |
| `3` | argv_memfd_slot      | uint (== `0xFD00`)               |
| `4` | env_memfd_slot       | uint \| null                     |
| `5` | stdin_slot           | uint                             |
| `6` | stdout_slot          | uint                             |
| `7` | stderr_slot          | uint                             |
| `8` | thread_id            | text 24-hex \| null              |
| `9` | adapter              | enum (`claude\|codex\|opencode\|cursor`) |
| `10`| hmac                 | bstr 16                          |

Ancillary fds (5 to 6 of them; counted exactly):

- `argv_memfd`: a `memfd_create()` containing the argv[0..N] joined by `\0`,
  null-terminated. Daemon parses, validates each arg < 4 KiB, total < 64 KiB.
- `env_memfd` (optional): same shape; KEY=VALUE pairs joined by `\0`.
- `stdin/stdout/stderr`: the bridge's stdio fds for the spawned process.

The daemon enters the project's persistent NS, drops to `$SVC_USER`, and
execs after applying `seccomp` (the same filter the existing
`ellul-seccomp-exec` applies). **No path strings cross the trust boundary** —
argv is delivered as memfd contents, env likewise.

Wave 0: log + reject.

### 7.8 `SPAWN` (client → server, opcode `0x41`) — Wave 1 only

Same shape as `ENTER` plus a `setup_inline` bool. If `true`, daemon performs
implicit setup (creates the NS) before exec. Used for one-shot agents.
Wave 0: log + reject.

### 7.9 `INJECT_ENV` (client → server, opcode `0x42`) — Wave 1 only

Request keys:

| Key | Field                | Type                  |
|-----|----------------------|-----------------------|
| `1` | request_id           | uint                  |
| `2` | nonce                | bstr 16               |
| `3` | env_memfd_slot       | uint (== `0xFD00`)    |
| `4` | target_kind          | enum (`per-thread`)   |
| `5` | thread_id            | text 24-hex \| null   |
| `6` | hmac                 | bstr 16               |

Ancillary: `env_memfd`. The daemon enters the project's mount NS in a worker
thread, opens the namespace's `/tmp` via the namespace's pre-pinned root fd
(daemon-cached at SETUP time, never path-resolved from a peer string),
`O_CREAT|O_WRONLY|O_NOFOLLOW|O_CLOEXEC`, writes from memfd, `fchown` to
`$SVC_USER`, `fchmod 0600`. Returns the in-namespace path the bridge can
reference (daemon-controlled, e.g. `/run/ellul-ns/env-<request_id>`).

The peer **never supplies a target path**. This closes H-5 (env-file TOCTOU)
and the symlink class of attacks: target is a daemon-controlled inode.

Wave 0: log + reject.

### 7.9.1 `BYOK_WRAP` (client → server, opcode `0x60`) and response `0x61`

Wraps a plaintext provider key into a project- and provider-scoped sealed
envelope. Per-project socket only. See
`docs/ELLUL-NAMESPACED-BYOK-DESIGN.md` for the full design.

Request CBOR keys (after `request_id` + `nonce`):

| Key | Field            | Type                     | Notes                                                     |
|-----|------------------|--------------------------|-----------------------------------------------------------|
| `3` | provider         | text ≤ 32                | matches `^[a-z][a-z0-9-]{0,31}$`                          |
| `4` | plaintext_memfd_slot | uint == `0xFD00`     | sentinel; sealed memfd in cmsg                            |

Ancillary: one fd, a sealed memfd
(`F_SEAL_WRITE|F_SEAL_GROW|F_SEAL_SHRINK`) containing the plaintext key
bytes (no terminator, no whitespace).

Response (opcode `0x61`):

| Key | Field         | Type            |
|-----|---------------|-----------------|
| `1` | request_id    | uint            |
| `2` | success       | bool            |
| `3` | wrapped       | bstr ≤ 4 KiB    |

`wrapped` is `nonce_24 || ciphertext` (libsodium standard layout). The
bridge stores it verbatim; daemon does not retain a copy.

### 7.9.2 `BYOK_UNWRAP` (client → server, opcode `0x62`) and response `0x63`

Reverse direction. Daemon unwraps, writes plaintext to a fresh sealed
memfd, sends via SCM_RIGHTS. The bridge does NOT typically call this
directly — the user-facing path is the inline-unwrap of `__byok-v1:`
markers in ENTER's env memfd.

Request CBOR keys:

| Key | Field         | Type            |
|-----|---------------|-----------------|
| `3` | provider      | text ≤ 32       |
| `4` | wrapped       | bstr ≤ 4 KiB    |

Response (opcode `0x63`):

| Key | Field            | Type             | Notes                          |
|-----|------------------|------------------|--------------------------------|
| `1` | request_id       | uint             |                                |
| `2` | success          | bool             |                                |
| `3` | plaintext_memfd_slot | uint == `0xFD00` | sentinel; sealed memfd in cmsg |

### 7.10 `TEARDOWN` (client → server, opcode `0x50`) — Wave 1 only

Request keys: `request_id`, `nonce`, `hmac`. Daemon stops the anchor unit,
unwinds iptables/ipset, drops per-project socket and group. Wave 0: log +
reject (the legacy bash path still does teardown).

### 7.11 Admin messages on `/run/ellul-ns/admin.sock`

| Opcode | Name                  | Notes                                                              |
|--------|-----------------------|--------------------------------------------------------------------|
| `0x80` | `CREATE_PROJECT`      | body: `project_slug`, `tier`. Daemon creates per-project group/socket. |
| `0x81` | `DROP_PROJECT`        | body: `project_slug`. Daemon removes per-project socket + group. |
| `0x82` | `EXPORT_MANIFEST_PUB` | body: empty. Response: 32-byte fingerprint + 32-byte raw pubkey. |
| `0x83` | `RECONCILE`           | body: array of expected project slugs. Daemon converges sockets/groups. |

These are reachable only from the admin socket. The same auth contract
applies; only `agent-bridge.service` and (for `RECONCILE`) the API
provisioner are in `ellul-ns-admin`.

---

## 8. Two-phase setup commit (Wave 1; design-frozen now)

Setting up a namespace involves ~26 mount syscalls today (see `ns-mount.c`).
Failure halfway through left orphan tmpfs mounts in the rollback branch. The
daemon's two-phase model:

1. **Stage** — fork a worker, `unshare(CLONE_NEWNS)`, perform every mount
   into a private tree, build the in-memory mount table.
2. **Attest** — within the worker, walk the manifest, statx every target,
   compute `mountinfo_digest`. If anything is off, the worker exits non-zero;
   the kernel reaps the namespace; nothing visible to the daemon's main
   thread changes.
3. **Activate** — daemon's main thread accepts the worker's success report,
   `pidfd_open`s the worker as the anchor PID, writes `/run/.ns-<project>/anchor.pid`,
   and **only now** binds `/run/ellul-ns/<project>/ctl.sock`. A failed attest
   never publishes a socket: a peer cannot ENTER a namespace whose mounts
   weren't proven correct.

Listen-fd activation: the daemon uses systemd socket activation per project
(transient `.socket` units created at `CREATE_PROJECT`). The activation file
descriptor is delivered via `LISTEN_FDS` only after `bind()` proceeds, so
"socket exists ⇔ namespace activated" remains true even across daemon
restarts.

---

## 9. Error taxonomy

Every response carries an `error` field (text) and `code` (uint). Codes:

| Code | Symbol                   | Meaning                                                      |
|------|--------------------------|--------------------------------------------------------------|
| 0    | `OK`                     | success                                                      |
| 1    | `EPROTO`                 | malformed CBOR / unknown key / oversize frame                |
| 2    | `EAUTH`                  | one of the §5 gates failed                                   |
| 3    | `EREPLAY`                | `request_id <= last_seen` for session                        |
| 4    | `EMANIFEST_SIG`          | Ed25519 verify failed                                        |
| 5    | `EMANIFEST_EXPIRED`      | `not_after_unix_ns < now`                                    |
| 6    | `EMANIFEST_PROJECT`      | manifest project ≠ socket project                            |
| 7    | `EATTEST_MISMATCH`       | one or more mount entries didn't match (details in body)     |
| 8    | `EANCHOR_DEAD`           | pidfd peer not alive                                         |
| 9    | `EANCHOR_CGROUP`         | pidfd peer not in expected slice                             |
| 10   | `EWAVE_READONLY`         | Wave 0 daemon rejected a write op                            |
| 11   | `EFD_KIND`               | passed fd's mode doesn't match expected slot                 |
| 12   | `ESTAGE_FAILED`          | Wave 1 stage worker exited non-zero                          |
| 13   | `EBUSY`                  | per-project lock held                                        |
| 14   | `EINTERNAL`              | daemon bug; details in log only                              |

`EINTERNAL` never includes daemon paths or stack traces in the wire response.

---

## 10. Versioning and forward compatibility

- The protocol version is at byte offset 0 of `HELLO`/`CLIENT_HELLO` (key
  `1`). A daemon that gets a `CLIENT_HELLO` with an unknown version replies
  `EPROTO` and disconnects. There is no backward-compat negotiation.
- Field additions in messages bump the version (1 → 2). Daemon and bridge
  ship together (both in `core-runtime-bundle`) so version skew lasts only
  for the duration of a rolling restart.
- The `features` bitfield in HELLO is for *strictly additive* opt-in features
  that don't change message shape (e.g. "daemon supports concurrent ATTEST").
- Manifest schema versioning is independent (key `1` of the manifest map);
  both `manifest_version` and `protocol_version` must rev together for
  shape changes.

---

## 11. Observability

Daemon emits two streams:

- **Structured events to `/var/log/ellul/agent-bridge-events.jsonl`**
  (existing path; daemon appends, never rotates — `logrotate` config rolls
  daily). Tags:
  - `nsd.session.open`, `nsd.session.close`
  - `nsd.attest.ok`, `nsd.attest.mismatch`, `nsd.attest.unreachable`
  - `nsd.auth.deny` (with `reason ∈ {peercred|peerpidfd|cgroup|hmac|fingerprint}`)
  - `nsd.replay.deny`
  - `nsd.wave0.write-rejected`
  - `nsd.startup.kernel-too-old` (one-shot, just before exit 78)
  - `nsd.health.ok` (rate-limited, at most once per 60s)
- **Phase log to `/var/log/ellul/nsd-phase.log`** (existing
  `ns-phase.log` shape) — one line per state transition, timestamped, for
  triage parity with the bash side.

The bridge's `EllulNamespacedClient.ts` emits parallel events
`bridge.nsd.attest.{ok|mismatch|unreachable}` so traces correlate without
relying on the daemon being writable from the bridge side.

---

## 12. Phased implementation surface

| Opcode               | Wave 0 | Phase A | Phase B    | Phase C  |
|----------------------|--------|---------|------------|----------|
| HELLO / CLIENT_HELLO | acted  | acted   | acted      | acted    |
| HEALTH               | acted  | acted   | acted      | acted    |
| ATTEST               | acted  | acted   | acted      | acted    |
| SETUP                | reject | acted   | acted      | acted    |
| TEARDOWN             | reject | acted   | acted      | acted    |
| CREATE_PROJECT       | reject | acted   | acted      | acted    |
| DROP_PROJECT         | reject | acted   | acted      | acted    |
| ENTER                | reject | reject  | acted      | acted    |
| INJECT_ENV           | reject | reject  | acted      | acted    |
| EXIT_NOTIFY          | n/a    | n/a     | server-initiated | server-initiated |
| SPAWN                | reject | reject  | reject     | acted    |
| BYOK_WRAP            | reject | reject  | reject     | acted    |
| BYOK_UNWRAP          | reject | reject  | reject     | acted    |

In Phase A, `SETUP` and `TEARDOWN` are admin-socket operations: the bridge
connects to `/run/ellul-ns/admin.sock` (not the per-project socket) and
sends a body containing the project slug. The daemon validates auth, then
`fork`+`execve`s `/usr/local/bin/ellul-agent-namespace setup|teardown
<project> [args]` with the daemon's caps (no sudo). The trust boundary
moves from `/etc/sudoers.d/dev-packages` to the daemon's HMAC-validated
control plane.

Phase B ENTER closes H-4 (cross-project entry via cmd-file) and H-5
(env-file TOCTOU). The bridge no longer writes env files to /tmp; argv
and env content travel as content of sealed memfds (bridge → helper →
daemon via SCM_RIGHTS), with the daemon validating
F_SEAL_WRITE|F_SEAL_GROW|F_SEAL_SHRINK before any read.

Implementation note — Node has no public API for sendmsg(2) ancillary
data. The bridge spawns `/usr/local/bin/ellul-fd-pass` as a child
process; the helper inherits stdio + control pipes via Node's stdio
array, builds the sealed memfds from content piped in, and emits the
sendmsg() call into the daemon socket. After ENTER_RESPONSE, the daemon
blocks on `waitpid(child)` and emits `EXIT_NOTIFY` (server-initiated)
when the child terminates. Bridge tracks one child per connection; the
helper exits when the daemon closes the socket.

Phase C (deferred) covers SPAWN (one-shot fresh namespace, infrequent),
the mount-staging rewrite using the new-mount-API, and full sudoers
removal once ENTER cutover stabilises.

---

## 13. Self-review: cross-project + path-supply

For every defined message, this table walks **(a) where project identity
comes from**, **(b) whether any peer-supplied string is used as a filesystem
path**, and **(c) the kernel-enforced gate on a hostile peer.**

| Message              | Project source                          | Peer-supplied path? | Gate                                                        |
|----------------------|-----------------------------------------|---------------------|-------------------------------------------------------------|
| HELLO                | n/a (server msg)                        | none                | n/a                                                         |
| CLIENT_HELLO         | n/a                                     | none                | n/a                                                         |
| HEALTH               | n/a                                     | none                | §5                                                          |
| ATTEST               | per-project socket path                 | none — manifest paths come from signed manifest, fds via SCM_RIGHTS | §5 + manifest sig + cgroup-of-anchor-pidfd        |
| SETUP (W1)           | per-project socket path                 | none — manifest signed, network CBOR validated against allowlist regex | §5 + manifest sig                                |
| ENTER (W1)           | per-project socket path                 | none — argv/env via memfd, no path strings | §5 + memfd-fstat-kind                                       |
| SPAWN (W1)           | per-project socket path                 | none                | §5 + memfd-fstat-kind                                       |
| INJECT_ENV (W1)      | per-project socket path                 | none — target inode is daemon-controlled, only env contents are peer-supplied | §5 + namespace root fd is daemon-pinned          |
| TEARDOWN (W1)        | per-project socket path                 | none                | §5                                                          |
| CREATE_PROJECT       | message body (`project_slug`)           | none — slug is regex-validated, used only to derive group/socket names under `/run/ellul-ns/` | §5 on admin socket                          |
| DROP_PROJECT         | message body                            | none                | §5 on admin socket                                          |
| EXPORT_MANIFEST_PUB  | n/a                                     | none                | §5 on admin socket                                          |
| RECONCILE            | message body (array of slugs)           | none — each slug regex-validated | §5 on admin socket                                          |

Two non-obvious invariants:

- **INJECT_ENV** is the only Wave-1 path where peer-supplied bytes (env content)
  reach a file the daemon writes. The destination *inode* is daemon-derived
  from the namespace root fd cached at SETUP time, and the daemon `O_NOFOLLOW`s
  to defeat post-creation symlink swaps. The peer never names a path; it gets
  a daemon-chosen path back in the response.
- **ATTEST** receives an anchor pidfd from the peer. A hostile peer could pass
  a pidfd of *some other* process to make the daemon attest the wrong NS. The
  cgroup-of-anchor check (step 5 in §7.4) rejects this: the anchor must be in
  `ellul-namespaces.slice/ellul-ns-<project>.service`, which is a transient
  slice the bash setup path creates and the daemon will create in Wave 1. A
  process the agent could fork is in `ellul-control-plane.slice` (the bridge's
  cgroup) and fails the check.

---

## 14. Open checkpoints (require user decision before code)

- **A. Kernel floor.** 6.5, hard-required, no fallback. Daemon refuses to start
  if `SO_PEERPIDFD` is missing (exit 78). Confirm.
- **B. Group provisioning policy.** Recommend P1 (per-project group, restart
  bridge on project add) for tightness; alternative is P2 (single shared
  group). Approve one.
- **C. CBOR library.** Recommend `libtinycbor-dev` from apt (Ubuntu 24.04
  universe). Alternative is vendoring tinycbor under
  `packages/vps/src/shell/helpers/ellul-namespaced/vendor/`. Approve one.
- **D. Ed25519 library.** Recommend `libsodium-dev` from apt (Ubuntu 24.04
  universe) for `crypto_sign_verify_detached`. Alternative is vendoring
  ed25519-donna or supercop ref10. Approve one.
- **E. Two-phase activation transport.** Recommend systemd-managed transient
  `.socket` units per project (LISTEN_FDS at activate-time). Alternative is
  daemon-internal `bind()` after attest. Approve one — the systemd path is
  cleaner but adds one transient unit per project and slows DROP_PROJECT.
- **F. Confirm `User=root` for daemon.** §3.4 explains why; flag if you want a
  system user with ambient caps instead.

Wave 0 can proceed once A–F are settled. None of the protocol shapes above
depend on these decisions; they affect implementation only.
