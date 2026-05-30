// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Bridge-side RPC client for `ellul-namespaced`.
 *
 * Both the daemon and this client are gated by feature flags
 * (`/etc/ellul/feature-flags/nsd-{enabled,client-enabled}`). Without those
 * files present, neither side does anything.
 *
 * The CBOR codec here is hand-rolled and minimal — only enough to encode/
 * decode the active message types. Match the daemon's tinycbor output
 * exactly: definite-length maps/arrays, smallest-int encodings, u8 keys.
 */

import { spawn, type ChildProcess } from "child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { EventEmitter } from "events";
import { connect, type Socket } from "net";
import * as fs from "fs";
import type { Readable, Writable } from "stream";

import { logEvent, serializeError } from "../../shared/event-log";
import { isTenantMode } from "@vps/shared/tenant-token";

// ── Constants (mirror daemon.h) ───────────────────────────

// Aligned with the daemon's gate (agent-sync.sh writes it after binary verify).
const FEATURE_FLAG_PATH      = "/etc/ellul/feature-flags/nsd-enabled";
const HMAC_KEY_INPUT_PATH    = "/etc/machine-id";
const MANIFEST_PUB_PATH      = "/etc/ellul/manifests/manifest.pub";
const SOCKET_DIR             = "/run/ellul-ns";
const ADMIN_SOCKET_PATH      = `${SOCKET_DIR}/admin.sock`;
const HMAC_LABEL             = "ellul-namespaced-v1";

const PROTOCOL_VERSION       = 1;
const NONCE_BYTES            = 16;
const HMAC_TAG_BYTES         = 16;
const FINGERPRINT_BYTES      = 32;
const SESSION_ID_BYTES       = 16;
const SHA256_BYTES           = 32;
const MAX_FRAME_BYTES        = 64 * 1024;

const OP_HELLO              = 0x01;
const OP_CLIENT_HELLO       = 0x02;
const OP_HEALTH             = 0x10;
const OP_HEALTH_RESPONSE    = 0x11;
const OP_ATTEST             = 0x20;
const OP_ATTEST_RESPONSE    = 0x21;
const OP_SETUP              = 0x30;
const OP_SETUP_RESPONSE     = 0x31;
const OP_TEARDOWN           = 0x50;
const OP_TEARDOWN_RESPONSE  = 0x51;
const OP_ENTER              = 0x40;
const OP_ENTER_RESPONSE     = 0x41;
const OP_INJECT_ENV         = 0x43;
const OP_INJECT_ENV_RESP    = 0x44;
const OP_EXIT_NOTIFY        = 0x45;
const OP_BYOK_WRAP          = 0x60;
const OP_BYOK_WRAP_RESP     = 0x61;
const OP_CREATE_PROJECT     = 0x80;
const OP_CREATE_PROJECT_RESP = 0x84;
const OP_DROP_PROJECT       = 0x81;
const OP_DROP_PROJECT_RESP  = 0x85;

const FD_PASS_BIN           = "/usr/local/bin/ellul-fd-pass";

/** Connect timeout in ms; observed startup delay on a fresh VPS is sub-100 ms. */
const CONNECT_TIMEOUT_MS    = 2_000;
/** Per-message response timeout. */
const REQUEST_TIMEOUT_MS    = 30_000;

// ── Public surface ────────────────────────────────────────

export interface AttestResult {
  ok: boolean;
  matches?: boolean;
  mismatches?: readonly string[];
  mountinfoDigest?: string;
  anchorAlive?: boolean;
  errcode?: number;
  errorMessage?: string;
}

export interface HealthResult {
  ok: boolean;
  uptimeMs?: number;
  manifestPubFp?: string;
  features?: number;
  errorMessage?: string;
}

export interface SetupRequest {
  /** Comma-joined `sbx-` slugs (e.g. "sbx-abc1234,sbx-def5678") or empty. */
  sharedProjects?: string;
  /** Space-joined "1"/"0" tokens, mirroring the bash setup script contract. */
  sharedPreviews?: string;
  /** Space-joined decimal port numbers in [4000, 4099] (or "0"). */
  sharedPorts?: string;
}

export interface SetupResult {
  ok: boolean;
  success?: boolean;
  anchorPid?: number;
  unitName?: string;
  errcode?: number;
  errorMessage?: string;
}

export interface TeardownResult {
  ok: boolean;
  success?: boolean;
  errcode?: number;
  errorMessage?: string;
}

export interface AdminResult {
  ok: boolean;
  errcode?: number;
  errorMessage?: string;
}

/**
 * Result of an ENTER call. Looks ChildProcess-shaped enough to drop in
 * for the small set of consumers in agent-bridge that actually use the
 * spawn return value:
 *   - pid, kill(), stdin, stdout, stderr, on('exit'/'error', ...)
 * The implementation is a thin EventEmitter wrapper around the helper
 * subprocess pipes.
 */
export interface NsdChildProcess extends EventEmitter {
  readonly pid: number | null;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * Returns true if the bridge has the runtime artefacts needed to talk to
 * the daemon: feature flag present, manifest pubkey on disk, fd-pass
 * helper executable. Cheap; safe to call from a hot path.
 */
export function isNsdClientEnabled(): boolean {
  // B2B tenant sandboxes MUST run daemon-less — the Incus micro-VM is the
  // isolation boundary, not the host namespace daemon. Hard-disable here so a
  // stray nsd-enabled flag can never pull a tenant bridge into daemon mode.
  if (isTenantMode()) return false;
  try {
    fs.accessSync(FEATURE_FLAG_PATH, fs.constants.R_OK);
    fs.accessSync(MANIFEST_PUB_PATH, fs.constants.R_OK);
    fs.accessSync(FD_PASS_BIN, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class EllulNamespacedClient {
  private socket: Socket;
  private project: string | null;
  private hmacKey: Buffer;
  private manifestPubFp: Buffer;
  private serverNonce: Buffer = Buffer.alloc(NONCE_BYTES);
  private sessionId: Buffer = Buffer.alloc(SESSION_ID_BYTES);
  private peerPidfdInode: bigint = 0n;
  private nextRequestId: bigint = 1n;
  private closed = false;
  private pendingResponse: ((frame: Buffer | null) => void) | null = null;
  private rxBuffer: Buffer = Buffer.alloc(0);

  private constructor(
    socket: Socket,
    project: string | null,
    hmacKey: Buffer,
    manifestPubFp: Buffer,
  ) {
    this.socket = socket;
    this.project = project;
    this.hmacKey = hmacKey;
    this.manifestPubFp = manifestPubFp;

    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", () => this.closeImmediate());
    socket.on("close", () => this.closeImmediate());
  }

  /**
   * Attempt to connect to the per-project socket. Returns null if the
   * feature flag is not set, the socket doesn't exist, or the handshake
   * fails — never throws. Safe to call after every spawn.
   */
  static async tryConnect(project: string): Promise<EllulNamespacedClient | null> {
    if (!isNsdClientEnabled()) return null;
    if (!/^sbx-[a-z0-9]{7}$/.test(project)) return null;
    return connectInternal(`${SOCKET_DIR}/${project}/ctl.sock`, project);
  }

  /**
   * Connect to the admin socket for SETUP/TEARDOWN/CREATE_PROJECT/DROP_PROJECT.
   * Returns null on failure. Caller is responsible for `close()`ing.
   */
  static async tryConnectAdmin(): Promise<EllulNamespacedClient | null> {
    if (!isNsdClientEnabled()) return null;
    return connectInternal(ADMIN_SOCKET_PATH, null);
  }

  /** ATTEST request. Resolves with the parsed result. */
  async attest(): Promise<AttestResult> {
    if (!this.project) return { ok: false, errorMessage: "no project" };
    const requestId = this.nextRequestId++;
    const nonce = randomBytes(NONCE_BYTES);
    const finalFrame = this.frameRequest(OP_ATTEST, requestId, nonce);
    const resp = await this.send(finalFrame);
    return parseAttestResponse(resp, requestId);
  }

  async health(): Promise<HealthResult> {
    const requestId = this.nextRequestId++;
    const nonce = randomBytes(NONCE_BYTES);
    const finalFrame = this.frameRequest(OP_HEALTH, requestId, nonce);
    const resp = await this.send(finalFrame);
    return parseHealthResponse(resp, requestId);
  }

  /**
   * SETUP via daemon. Admin-socket only. The daemon delegates to
   * `/usr/local/bin/ellul-agent-namespace setup` with HMAC-validated args
   * — no sudo, no shell argv on the trust boundary.
   */
  async setup(project: string, req: SetupRequest = {}): Promise<SetupResult> {
    if (this.project) return { ok: false, errorMessage: "setup requires admin connection" };
    if (!/^sbx-[a-z0-9]{7}$/.test(project)) {
      return { ok: false, errorMessage: "invalid project slug" };
    }
    const requestId = this.nextRequestId++;
    const nonce = randomBytes(NONCE_BYTES);
    const extras: Array<[number, Buffer]> = [
      [3, encText(project)],
    ];
    if (req.sharedProjects) extras.push([4, encText(req.sharedProjects)]);
    if (req.sharedPreviews) extras.push([5, encText(req.sharedPreviews)]);
    if (req.sharedPorts) extras.push([6, encText(req.sharedPorts)]);
    const finalFrame = this.frameRequestWithExtras(OP_SETUP, requestId, nonce, extras);
    const resp = await this.send(finalFrame);
    return parseSetupResponse(resp, requestId);
  }

  /** TEARDOWN via daemon. Admin-socket only. */
  async teardown(project: string): Promise<TeardownResult> {
    if (this.project) return { ok: false, errorMessage: "teardown requires admin connection" };
    if (!/^sbx-[a-z0-9]{7}$/.test(project)) {
      return { ok: false, errorMessage: "invalid project slug" };
    }
    const requestId = this.nextRequestId++;
    const nonce = randomBytes(NONCE_BYTES);
    const extras: Array<[number, Buffer]> = [[3, encText(project)]];
    const finalFrame = this.frameRequestWithExtras(OP_TEARDOWN, requestId, nonce, extras);
    const resp = await this.send(finalFrame);
    return parseTeardownResponse(resp, requestId);
  }

  async createProject(project: string): Promise<AdminResult> {
    if (this.project) return { ok: false, errorMessage: "admin op requires admin connection" };
    if (!/^sbx-[a-z0-9]{7}$/.test(project)) {
      return { ok: false, errorMessage: "invalid project slug" };
    }
    const requestId = this.nextRequestId++;
    const nonce = randomBytes(NONCE_BYTES);
    const extras: Array<[number, Buffer]> = [[3, encText(project)]];
    const finalFrame = this.frameRequestWithExtras(OP_CREATE_PROJECT, requestId, nonce, extras);
    const resp = await this.send(finalFrame);
    return parseAdminResponse(resp, requestId, OP_CREATE_PROJECT_RESP);
  }

  /**
   * ENTER via daemon. Spawns the agent CLI inside the project's namespace
   * using the fd-pass helper to ferry sealed memfds + child-stdio across
   * SCM_RIGHTS to the daemon. Returns a ChildProcess-like object the caller
   * can wire up like a normal spawn.
   *
   * Important: this does NOT use `this` — the daemon connection is owned
   * by the helper subprocess. We treat the existing client as a shape
   * holder for shared state (HMAC key, manifest fp); the actual socket
   * is opened by the helper.
   */
  static enter(
    project: string,
    argv: ReadonlyArray<string>,
    options: {
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      /**
       * Absolute cgroup-v2 path the daemon should join the worker into,
       * instead of the anchor's own cgroup. Required for adapterScope
       * (resource-v2 pool/slot) spawns so the child lands under the
       * per-sandbox transient slice. Daemon validates shape + project
       * binding; bridge must materialize the cgroup before the call.
       */
      targetCgroup?: string;
    } = {},
  ): NsdChildProcess {
    if (!isNsdClientEnabled()) {
      throw new Error("ellul-namespaced client preconditions absent");
    }
    if (!/^sbx-[a-z0-9]{7}$/.test(project)) {
      throw new Error(`invalid project slug: ${project}`);
    }
    if (options.targetCgroup !== undefined) {
      validateTargetCgroup(project, options.targetCgroup);
    }

    const target = `${SOCKET_DIR}/${project}/ctl.sock`;

    /* Build the bridge frame BODY (CBOR map without HMAC trailer; the
     * helper appends the trailer? — actually the bridge computes HMAC
     * because only the bridge has the session_id from HELLO. So bridge
     * does the full handshake first via the helper's stdio proxy.
     *
     * Sequence:
     *   1. Spawn helper with all the pipes
     *   2. Write CLIENT_HELLO frame to helper stdin AFTER reading HELLO
     *   3. Write argv content to argv pipe; same for env
     *   4. Write the ENTER frame body to frame pipe
     *   5. Helper builds memfds, connects to daemon, sends frame + cmsg
     *   6. Bridge reads ENTER_RESPONSE from helper stdout
     *   7. Bridge waits for EXIT_NOTIFY (also on helper stdout)
     *   8. Helper exits when daemon closes the connection
     */

    /* Helper stdio array:
     *   [0] helper stdin       — bridge writes CLIENT_HELLO + further requests
     *   [1] helper stdout      — bridge reads HELLO + ENTER_RESPONSE + EXIT_NOTIFY
     *   [2] helper stderr      — debug
     *   [3] frame fd           — bridge writes ENTER frame
     *   [4] argv-fd            — bridge writes argv content
     *   [5] env-fd             — bridge writes env content
     *   [6] child stdin        — bridge writes -> child reads
     *   [7] child stdout       — child writes -> bridge reads
     *   [8] child stderr       — child writes -> bridge reads
     */
    const helper = spawn(FD_PASS_BIN, [
      `--target=${target}`,
      `--frame-fd=3`,
      `--argv-fd=4`,
      `--env-fd=5`,
      `--fd=stdin:6,stdout:7,stderr:8`,
    ], {
      stdio: ["pipe", "pipe", "pipe",
              "pipe", "pipe", "pipe",
              "pipe", "pipe", "pipe"],
    });

    return wireEnterChild(helper, project, argv, options);
  }

  /**
   * BYOK_WRAP via the per-project socket. Bridges the plaintext through
   * the fd-pass helper (which builds a sealed memfd and sendmsg's it to
   * the daemon). The daemon derives a project+provider-scoped subkey
   * via HKDF-SHA256, secretbox-encrypts, and returns the wire bytes.
   *
   * Returns the raw ciphertext (nonce(24) || encrypted(plaintext+16)).
   * Caller is responsible for base64-encoding into the
   * __byok-v1:<provider>:<b64> marker if storing alongside other env
   * values.
   *
   * The bridge's plaintext Buffer is zeroed on every code path before
   * return — even on error. Heap-side memfd write is the only copy
   * that traverses into the daemon.
   */
  static async byokWrap(
    project: string,
    provider: string,
    plaintext: Buffer,
  ): Promise<Buffer> {
    if (!isNsdClientEnabled()) {
      plaintext.fill(0);
      throw new Error("ellul-namespaced client preconditions absent");
    }
    if (!/^sbx-[a-z0-9]{7}$/.test(project)) {
      plaintext.fill(0);
      throw new Error(`invalid project slug: ${project}`);
    }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(provider)) {
      plaintext.fill(0);
      throw new Error(`invalid provider id: ${provider}`);
    }
    if (plaintext.length === 0 || plaintext.length > 4096) {
      plaintext.fill(0);
      throw new Error(`plaintext length ${plaintext.length} out of range`);
    }
    const target = `${SOCKET_DIR}/${project}/ctl.sock`;

    /* Helper stdio:
     *   [0] stdin     — bridge writes CLIENT_HELLO + further requests
     *   [1] stdout    — bridge reads HELLO + BYOK_WRAP_RESP
     *   [2] stderr    — debug
     *   [3] frame-fd  — bridge writes BYOK_WRAP frame
     *   [4] argv-fd   — bridge writes plaintext content
     * (No env-fd, no named --fd= entries — daemon expects exactly one
     * sealed memfd from --argv-fd.) */
    const helper = spawn(FD_PASS_BIN, [
      `--target=${target}`,
      `--frame-fd=3`,
      `--argv-fd=4`,
    ], {
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    });

    try {
      return await driveByokWrap(helper, provider, plaintext);
    } finally {
      plaintext.fill(0);
    }
  }

  async dropProject(project: string): Promise<AdminResult> {
    if (this.project) return { ok: false, errorMessage: "admin op requires admin connection" };
    if (!/^sbx-[a-z0-9]{7}$/.test(project)) {
      return { ok: false, errorMessage: "invalid project slug" };
    }
    const requestId = this.nextRequestId++;
    const nonce = randomBytes(NONCE_BYTES);
    const extras: Array<[number, Buffer]> = [[3, encText(project)]];
    const finalFrame = this.frameRequestWithExtras(OP_DROP_PROJECT, requestId, nonce, extras);
    const resp = await this.send(finalFrame);
    return parseAdminResponse(resp, requestId, OP_DROP_PROJECT_RESP);
  }

  /**
   * Build a frame with extra per-opcode CBOR keys after request_id+nonce.
   * Followed by the 16-byte HMAC trailer.
   */
  private frameRequestWithExtras(
    opcode: number,
    requestId: bigint,
    nonce: Buffer,
    extras: Array<[number, Buffer]>,
  ): Buffer {
    const entries: Array<[number, Buffer]> = [
      [1, encUint(requestId)],
      [2, encBstr(nonce)],
      ...extras,
    ];
    const body = encMap(entries);
    const prefix = Buffer.concat([Buffer.from([opcode]), body]);
    const bodyDigest = createHash("sha256").update(prefix).digest();
    const hmacInput = Buffer.alloc(SESSION_ID_BYTES + 8 + NONCE_BYTES + 8 + SHA256_BYTES);
    let off = 0;
    this.sessionId.copy(hmacInput, off); off += SESSION_ID_BYTES;
    hmacInput.writeBigUInt64BE(requestId, off); off += 8;
    nonce.copy(hmacInput, off); off += NONCE_BYTES;
    hmacInput.writeBigUInt64BE(this.peerPidfdInode, off); off += 8;
    bodyDigest.copy(hmacInput, off);
    const hmacTag = createHmac("sha256", this.hmacKey).update(hmacInput).digest()
      .subarray(0, HMAC_TAG_BYTES);
    return Buffer.concat([prefix, hmacTag]);
  }

  /**
   * Build a request frame: [opcode][CBOR map][HMAC trailer (16 bytes)].
   * The HMAC is computed over the bytes ahead of it (opcode + CBOR), and
   * keyed by the session secrets — see protocol §5.
   */
  private frameRequest(opcode: number, requestId: bigint, nonce: Buffer): Buffer {
    const body = encMap([
      [1, encUint(requestId)],
      [2, encBstr(nonce)],
    ]);
    const prefix = Buffer.concat([Buffer.from([opcode]), body]);
    const bodyDigest = createHash("sha256").update(prefix).digest();
    const hmacInput = Buffer.alloc(SESSION_ID_BYTES + 8 + NONCE_BYTES + 8 + SHA256_BYTES);
    let off = 0;
    this.sessionId.copy(hmacInput, off); off += SESSION_ID_BYTES;
    hmacInput.writeBigUInt64BE(requestId, off); off += 8;
    nonce.copy(hmacInput, off); off += NONCE_BYTES;
    hmacInput.writeBigUInt64BE(this.peerPidfdInode, off); off += 8;
    bodyDigest.copy(hmacInput, off);
    const hmacTag = createHmac("sha256", this.hmacKey).update(hmacInput).digest()
      .subarray(0, HMAC_TAG_BYTES);
    return Buffer.concat([prefix, hmacTag]);
  }

  close(): void { this.closeImmediate(); }

  private closeImmediate(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch { /* swallow */ }
    if (this.pendingResponse) {
      const resolve = this.pendingResponse;
      this.pendingResponse = null;
      resolve(null);
    }
  }

  private onData(chunk: Buffer): void {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    while (this.rxBuffer.length >= 4) {
      const len = this.rxBuffer.readUInt32BE(0);
      if (len === 0 || len > MAX_FRAME_BYTES) {
        this.closeImmediate();
        return;
      }
      if (this.rxBuffer.length < 4 + len) return;
      const frame = this.rxBuffer.subarray(4, 4 + len);
      this.rxBuffer = this.rxBuffer.subarray(4 + len);
      const handler = this.pendingResponse;
      this.pendingResponse = null;
      if (handler) handler(Buffer.from(frame));
    }
  }

  private send(frame: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error("client closed")); return; }
      if (this.pendingResponse) {
        reject(new Error("request in flight"));
        return;
      }
      const timer = setTimeout(() => {
        this.pendingResponse = null;
        reject(new Error("nsd request timeout"));
      }, REQUEST_TIMEOUT_MS);
      this.pendingResponse = (frame) => {
        clearTimeout(timer);
        if (frame === null) reject(new Error("nsd connection closed"));
        else resolve(frame);
      };
      const header = Buffer.alloc(4);
      header.writeUInt32BE(frame.length, 0);
      this.socket.write(Buffer.concat([header, frame]), (err) => {
        if (err) {
          this.pendingResponse = null;
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  private async handshake(): Promise<void> {
    /* Daemon sends HELLO unsolicited within ~100ms of accept. */
    const hello = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponse = null;
        reject(new Error("nsd HELLO timeout"));
      }, REQUEST_TIMEOUT_MS);
      this.pendingResponse = (f) => {
        clearTimeout(timer);
        if (f === null) reject(new Error("connection closed before HELLO"));
        else resolve(f);
      };
    });

    if (hello.length < 2 || hello[0] !== OP_HELLO) throw new Error("bad HELLO opcode");
    const helloMap = parseMap(hello, 1);
    const protocolVersion = readUintEntry(helloMap, 1);
    const serverNonce = readBstrEntry(helloMap, 2);
    const fp = readBstrEntry(helloMap, 3);
    const sessionId = readBstrEntry(helloMap, 4);
    if (protocolVersion !== PROTOCOL_VERSION) throw new Error("nsd version mismatch");
    if (serverNonce.length !== NONCE_BYTES) throw new Error("bad server_nonce");
    if (fp.length !== FINGERPRINT_BYTES) throw new Error("bad pubkey fingerprint");
    if (sessionId.length !== SESSION_ID_BYTES) throw new Error("bad session_id");
    if (!timingSafeEqual(fp, this.manifestPubFp)) {
      throw new Error("manifest pubkey fingerprint mismatch");
    }
    this.serverNonce = serverNonce;
    this.sessionId = sessionId;

    /* peer_pidfd_inode (key 6 in HELLO) — the daemon's view of fstat(pidfd).st_ino
     * for our side. We can't observe this from the bridge side; the daemon
     * echoes it so both ends bind per-message HMAC to the same value.
     * Different reconnect ⇒ different pidfd object ⇒ different inode ⇒
     * captured frames from the prior session fail HMAC against the new one. */
    const inodeEntry = findEntry(helloMap, 6);
    if (!inodeEntry || inodeEntry.major !== 0) {
      throw new Error("HELLO missing peer_pidfd_inode");
    }
    this.peerPidfdInode = inodeEntry.value as bigint;

    const clientNonce = randomBytes(NONCE_BYTES);
    const idHint = `agent-bridge:pid=${process.pid}`;
    const sessionHmac = computeSessionHmac(this.hmacKey, this.serverNonce, clientNonce, idHint);
    const body = encMap([
      [1, encUint(BigInt(PROTOCOL_VERSION))],
      [2, encBstr(clientNonce)],
      [3, encText(idHint)],
      [4, encBstr(this.manifestPubFp)],
      [5, encBstr(sessionHmac)],
    ]);
    const frame = Buffer.concat([Buffer.from([OP_CLIENT_HELLO]), body]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(frame.length, 0);
    await new Promise<void>((resolve, reject) => {
      this.socket.write(Buffer.concat([header, frame]), (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

}

// ── Helpers ───────────────────────────────────────────────

/**
 * Mirror of the daemon's target_cgroup_path_ok validator. Throws on shape
 * violations; daemon re-validates server-side, so this is fast feedback,
 * not security. Cheap; safe in the spawn hot path.
 */
function validateTargetCgroup(project: string, path: string): void {
  if (path.length >= 256) {
    throw new Error(`adapterScope: target_cgroup too long (${path.length}>=256)`);
  }
  if (path.includes("..") || path.includes("//")) {
    throw new Error(`adapterScope: target_cgroup contains forbidden tokens`);
  }
  const m = project.match(/^sbx-([a-z0-9]{7})$/);
  if (!m) throw new Error(`adapterScope: invalid project slug ${project}`);
  const short = m[1]!;
  const expected = new RegExp(
    `^/sys/fs/cgroup/ellul\\.slice/ellul-user-workload\\.slice/` +
      `ellul-user-workload-sbx-${short}\\.slice/` +
      `ellul-pool-sbx-${short}-(claude|opencode|cursor|codex)-` +
      `[a-zA-Z0-9_-]{1,32}\\.scope/?$`,
  );
  if (!expected.test(path)) {
    throw new Error(
      `adapterScope: target_cgroup ${path} does not match expected shape ` +
        `for project ${project}`,
    );
  }
}

function deriveHmacKey(): Buffer {
  const machineId = fs.readFileSync(HMAC_KEY_INPUT_PATH, "utf8").trim();
  if (machineId.length < 8) throw new Error("/etc/machine-id too short");
  /* SHA256("ellul-namespaced-v1\0" || machine-id-bytes). The C side passes
   * the label INCLUDING its trailing NUL via sizeof("...") which counts
   * the NUL; we mirror that. */
  const h = createHash("sha256");
  h.update(Buffer.from(`${HMAC_LABEL}\0`, "utf8"));
  h.update(Buffer.from(machineId, "utf8"));
  return h.digest();
}

function readManifestPubFingerprint(): Buffer {
  const raw = fs.readFileSync(MANIFEST_PUB_PATH);
  let pub: Buffer;
  if (raw.length === 32) {
    pub = raw;
  } else {
    const hex = raw.toString("ascii").replace(/\s+/g, "");
    if (hex.length !== 64) throw new Error("manifest.pub: expected 32 raw bytes or 64 hex chars");
    pub = Buffer.from(hex, "hex");
    if (pub.length !== 32) throw new Error("manifest.pub: hex decode failed");
  }
  return createHash("sha256").update(pub).digest();
}

function computeSessionHmac(
  key: Buffer,
  serverNonce: Buffer,
  clientNonce: Buffer,
  clientIdHint: string,
): Buffer {
  const h = createHmac("sha256", key);
  h.update(serverNonce);
  h.update(clientNonce);
  h.update(Buffer.from(clientIdHint, "utf8"));
  return h.digest().subarray(0, HMAC_TAG_BYTES);
}

function connectUnix(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`connect timeout: ${path}`));
    }, CONNECT_TIMEOUT_MS);
    sock.once("connect", () => { clearTimeout(timer); resolve(sock); });
    sock.once("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Wire up the helper subprocess into a ChildProcess-shaped object. Handles
 * the HELLO/CLIENT_HELLO handshake, ENTER frame construction (with HMAC
 * trailer), and EXIT_NOTIFY wait.
 */
function wireEnterChild(
  helper: ChildProcess,
  project: string,
  argv: ReadonlyArray<string>,
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    targetCgroup?: string;
  },
): NsdChildProcess {
  const emitter = new EventEmitter();
  let pid: number | null = null;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;

  const helperStdio = helper.stdio as unknown as Array<unknown>;
  if (!helperStdio || helperStdio.length < 9) {
    throw new Error("fd-pass helper stdio array malformed");
  }
  const helperIn  = helperStdio[0] as Writable;
  const helperOut = helperStdio[1] as Readable;
  const helperErr = helperStdio[2] as Readable;
  const frameFd   = helperStdio[3] as Writable;
  const argvFd    = helperStdio[4] as Writable;
  const envFd     = helperStdio[5] as Writable;
  const childIn   = helperStdio[6] as Writable;
  const childOut  = helperStdio[7] as Readable;
  const childErr  = helperStdio[8] as Readable;

  /* Drain helper stderr to logs. */
  const errChunks: Buffer[] = [];
  helperErr.on("data", (b: Buffer) => {
    errChunks.push(b);
    if (errChunks.length > 32) errChunks.shift();
  });

  /* Read frames from helper stdout: 4-byte BE length + body. */
  let rxBuf = Buffer.alloc(0);
  let onFrame: ((frame: Buffer) => void) | null = null;
  helperOut.on("data", (chunk: Buffer) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    while (rxBuf.length >= 4) {
      const len = rxBuf.readUInt32BE(0);
      if (len === 0 || len > MAX_FRAME_BYTES) {
        emitter.emit("error", new Error(`bad frame length ${len}`));
        helper.kill();
        return;
      }
      if (rxBuf.length < 4 + len) return;
      const body = Buffer.from(rxBuf.subarray(4, 4 + len));
      rxBuf = rxBuf.subarray(4 + len);
      const cb = onFrame;
      onFrame = null;
      if (cb) cb(body);
      else handleUnsolicited(body);
    }
  });
  helperOut.on("end", () => {
    if (exitCode === null) {
      emitter.emit("error", new Error("helper closed before EXIT_NOTIFY"));
    }
  });
  helper.on("error", (err) => emitter.emit("error", err));
  helper.on("exit", (code, signal) => {
    /* If we never got EXIT_NOTIFY, surface helper's exit as the child's
     * exit (best effort). */
    if (exitCode === null && signalCode === null) {
      exitCode = code ?? null;
      signalCode = (signal as NodeJS.Signals) ?? null;
      emitter.emit("exit", exitCode, signalCode);
    }
  });

  function recvOne(timeoutMs = REQUEST_TIMEOUT_MS): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        onFrame = null;
        reject(new Error("frame timeout"));
      }, timeoutMs);
      onFrame = (f) => { clearTimeout(timer); resolve(f); };
    });
  }

  function handleUnsolicited(frame: Buffer): void {
    if (frame.length < 2) return;
    const op = frame[0]!;
    if (op !== OP_EXIT_NOTIFY) return;
    /* CBOR keys: 1=request_id, 2=child_pid, 3=exit_code (signed). */
    try {
      const map = parseMap(frame, 1);
      const codeEntry = findEntry(map, 3);
      let code = 0;
      if (codeEntry && (codeEntry.major === 0 || codeEntry.major === 1)) {
        code = Number(codeEntry.value as bigint);
      }
      if (code < 0) {
        signalCode = `${-code}` as NodeJS.Signals;
        exitCode = null;
      } else {
        exitCode = code;
        signalCode = null;
      }
      emitter.emit("exit", exitCode, signalCode);
    } catch {
      emitter.emit("error", new Error("malformed EXIT_NOTIFY"));
    }
  }

  /* Async handshake + frame build. */
  (async () => {
    let hmacKey: Buffer;
    let manifestPubFp: Buffer;
    try {
      hmacKey = deriveHmacKey();
      manifestPubFp = readManifestPubFingerprint();
    } catch (err) {
      emitter.emit("error", err);
      helper.kill();
      return;
    }

    /* Stage 1 — HELLO from helper. */
    const hello = await recvOne();
    if (hello[0] !== OP_HELLO) throw new Error("expected HELLO");
    const helloMap = parseMap(hello, 1);
    const protocolVersion = readUintEntry(helloMap, 1);
    const serverNonce = readBstrEntry(helloMap, 2);
    const fp = readBstrEntry(helloMap, 3);
    const sessionId = readBstrEntry(helloMap, 4);
    const inodeEntry = findEntry(helloMap, 6);
    if (protocolVersion !== PROTOCOL_VERSION) throw new Error("nsd version mismatch");
    if (!timingSafeEqual(fp, manifestPubFp)) throw new Error("manifest fp mismatch");
    if (!inodeEntry || inodeEntry.major !== 0) throw new Error("missing peer_pidfd_inode");
    const peerInode = inodeEntry.value as bigint;

    /* Stage 2 — CLIENT_HELLO. */
    const clientNonce = randomBytes(NONCE_BYTES);
    const idHint = `agent-bridge:enter:${process.pid}`;
    const sessionHmac = computeSessionHmac(hmacKey, serverNonce, clientNonce, idHint);
    const chBody = encMap([
      [1, encUint(BigInt(PROTOCOL_VERSION))],
      [2, encBstr(clientNonce)],
      [3, encText(idHint)],
      [4, encBstr(manifestPubFp)],
      [5, encBstr(sessionHmac)],
    ]);
    const chFrame = Buffer.concat([Buffer.from([OP_CLIENT_HELLO]), chBody]);
    const chHdr = Buffer.alloc(4);
    chHdr.writeUInt32BE(chFrame.length, 0);
    helperIn.write(Buffer.concat([chHdr, chFrame]));

    /* Stage 3 — write argv + env content to their pipes; helper memfd's
     * them and seals before sendmsg. */
    const argvBlob = Buffer.concat(argv.map((a) => Buffer.concat([Buffer.from(a, "utf8"), Buffer.from([0])])));
    argvFd.end(argvBlob);

    const envSrc = options.env ?? {};
    const envEntries: Buffer[] = [];
    for (const [k, v] of Object.entries(envSrc)) {
      if (v === undefined) continue;
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) continue;
      const sanitized = String(v).replace(/[\x00-\x1f\x7f]/g, "");
      envEntries.push(Buffer.from(`${k}=${sanitized}\0`, "utf8"));
    }
    envFd.end(envEntries.length > 0 ? Buffer.concat(envEntries) : Buffer.alloc(0));

    /* Stage 3.5 — if the caller passed targetCgroup, the per-pool
     * transient scope was just spawned via ellul-spawn-scope. systemd
     * creates the cgroup synchronously when StartTransientUnit returns,
     * but the bridge does NOT wait for sudo→systemd-run; the scope
     * directory may not exist yet by the time we send the frame. Poll
     * up to 3 s before failing. Daemon's open(O_DIRECTORY) returns
     * ENOENT otherwise — losing the race surfaces as a confusing
     * exit-122 from the worker child. */
    if (options.targetCgroup) {
      const deadline = Date.now() + 3_000;
      while (!fs.existsSync(options.targetCgroup)) {
        if (Date.now() > deadline) {
          throw new Error(
            `adapterScope: target_cgroup ${options.targetCgroup} did not appear within 3 s — ` +
              `ellul-spawn-scope failed to materialize the transient scope`,
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    /* Stage 4 — build the ENTER frame: CBOR + HMAC trailer. Key 11
     * (target_cgroup) carries the adapterScope cgroup path when the
     * caller supplied one; absent for non-pool spawns. */
    const requestId = 1n;
    const nonce = randomBytes(NONCE_BYTES);
    const enterEntries: Array<[number, Buffer]> = [
      [1, encUint(requestId)],
      [2, encBstr(nonce)],
    ];
    if (options.targetCgroup) {
      enterEntries.push([11, encText(options.targetCgroup)]);
    }
    const enterBody = encMap(enterEntries);
    const prefix = Buffer.concat([Buffer.from([OP_ENTER]), enterBody]);
    const bodyDigest = createHash("sha256").update(prefix).digest();
    const hmacInput = Buffer.alloc(SESSION_ID_BYTES + 8 + NONCE_BYTES + 8 + SHA256_BYTES);
    let off = 0;
    sessionId.copy(hmacInput, off); off += SESSION_ID_BYTES;
    hmacInput.writeBigUInt64BE(requestId, off); off += 8;
    nonce.copy(hmacInput, off); off += NONCE_BYTES;
    hmacInput.writeBigUInt64BE(peerInode, off); off += 8;
    bodyDigest.copy(hmacInput, off);
    const hmacTag = createHmac("sha256", hmacKey).update(hmacInput).digest()
      .subarray(0, HMAC_TAG_BYTES);
    const fullFrame = Buffer.concat([prefix, hmacTag]);
    const fullHdr = Buffer.alloc(4);
    fullHdr.writeUInt32BE(fullFrame.length, 0);
    frameFd.end(Buffer.concat([fullHdr, fullFrame]));

    /* Stage 5 — read ENTER_RESPONSE. */
    const resp = await recvOne();
    const respOp = resp[0]!;
    if (respOp === 0xff) {
      const m = parseMap(resp, 1);
      const errcode = (() => { try { return readUintEntry(m, 14); } catch { return 0; }})();
      const e = findEntry(m, 15);
      const msg = (e && e.major === 3) ? (e.value as string) : "enter rejected";
      emitter.emit("error", new Error(`enter denied: ${msg} (errcode=${errcode})`));
      helper.kill();
      return;
    }
    if (respOp !== OP_ENTER_RESPONSE) {
      emitter.emit("error", new Error(`unexpected enter resp opcode 0x${respOp.toString(16)}`));
      helper.kill();
      return;
    }
    const respMap = parseMap(resp, 1);
    pid = readUintEntry(respMap, 3);
    emitter.emit("spawn");
    /* From here, EXIT_NOTIFY arrives on helperOut as unsolicited. */
  })().catch((err) => {
    emitter.emit("error", err);
    try { helper.kill(); } catch { /* ignore */ }
  });

  /* Build and return the NsdChildProcess shape. */
  const child: NsdChildProcess = Object.assign(emitter, {
    get pid() { return pid; },
    get stdin() { return childIn; },
    get stdout() { return childOut; },
    get stderr() { return childErr; },
    get exitCode() { return exitCode; },
    get signalCode() { return signalCode; },
    kill(signal?: NodeJS.Signals | number) {
      if (pid === null) {
        try { helper.kill(); } catch { /* ignore */ }
        return false;
      }
      try {
        process.kill(pid, signal ?? "SIGTERM");
        return true;
      } catch {
        return false;
      }
    },
  } satisfies Omit<NsdChildProcess, keyof EventEmitter>);
  void options.cwd;  /* not honored — daemon sets cwd to project workspace */
  return child;
}

/**
 * Drive a BYOK_WRAP exchange through ellul-fd-pass. The flow is:
 *   1. Helper opens the daemon socket; we read HELLO from helper.stdout.
 *   2. Bridge writes CLIENT_HELLO to helper.stdin.
 *   3. Bridge writes plaintext to argv-fd; helper builds + seals a memfd.
 *   4. Bridge writes BYOK_WRAP frame (CBOR + HMAC trailer) to frame-fd.
 *   5. Helper sendmsg's frame + memfd to the daemon.
 *   6. Bridge reads BYOK_WRAP_RESP from helper.stdout, returns ciphertext.
 *
 * Uses the same handshake math as wireEnterChild / connectInternal —
 * factored together would be cleaner but the lifetime + return-shape
 * differences make a copy more readable than another helper indirection.
 */
async function driveByokWrap(
  helper: ChildProcess,
  provider: string,
  plaintext: Buffer,
): Promise<Buffer> {
  const helperStdio = helper.stdio as unknown as Array<unknown>;
  if (!helperStdio || helperStdio.length < 5) {
    throw new Error("byokWrap helper stdio array malformed");
  }
  const helperIn  = helperStdio[0] as Writable;
  const helperOut = helperStdio[1] as Readable;
  const helperErr = helperStdio[2] as Readable;
  const frameFd   = helperStdio[3] as Writable;
  const argvFd    = helperStdio[4] as Writable;

  /* Drain helper stderr to logs to surface fd-pass errors on failure. */
  const errChunks: Buffer[] = [];
  helperErr.on("data", (b: Buffer) => {
    errChunks.push(b);
    if (errChunks.length > 32) errChunks.shift();
  });

  /* Read frames from helper stdout (4-byte BE length + body). */
  let rxBuf = Buffer.alloc(0);
  let onFrame: ((frame: Buffer) => void) | null = null;
  helperOut.on("data", (chunk: Buffer) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    while (rxBuf.length >= 4) {
      const len = rxBuf.readUInt32BE(0);
      if (len === 0 || len > MAX_FRAME_BYTES) {
        onFrame = null;
        helper.kill();
        return;
      }
      if (rxBuf.length < 4 + len) return;
      const body = Buffer.from(rxBuf.subarray(4, 4 + len));
      rxBuf = rxBuf.subarray(4 + len);
      const cb = onFrame;
      onFrame = null;
      if (cb) cb(body);
    }
  });

  function recvOne(timeoutMs = REQUEST_TIMEOUT_MS): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        onFrame = null;
        const errTail = Buffer.concat(errChunks).toString("utf8");
        reject(new Error(`byokWrap frame timeout (helper stderr=${errTail})`));
      }, timeoutMs);
      onFrame = (f) => { clearTimeout(timer); resolve(f); };
    });
  }

  const hmacKey = deriveHmacKey();
  const manifestPubFp = readManifestPubFingerprint();

  /* Stage 1 — HELLO. */
  const hello = await recvOne();
  if (hello[0] !== OP_HELLO) throw new Error("expected HELLO");
  const helloMap = parseMap(hello, 1);
  const protocolVersion = readUintEntry(helloMap, 1);
  const serverNonce = readBstrEntry(helloMap, 2);
  const fp = readBstrEntry(helloMap, 3);
  const sessionId = readBstrEntry(helloMap, 4);
  const inodeEntry = findEntry(helloMap, 6);
  if (protocolVersion !== PROTOCOL_VERSION) throw new Error("nsd version mismatch");
  if (!timingSafeEqual(fp, manifestPubFp)) throw new Error("manifest fp mismatch");
  if (!inodeEntry || inodeEntry.major !== 0) {
    throw new Error("missing peer_pidfd_inode");
  }
  const peerInode = inodeEntry.value as bigint;

  /* Stage 2 — CLIENT_HELLO. */
  const clientNonce = randomBytes(NONCE_BYTES);
  const idHint = `agent-bridge:byokWrap:${process.pid}`;
  const sessionHmac = computeSessionHmac(hmacKey, serverNonce, clientNonce, idHint);
  const chBody = encMap([
    [1, encUint(BigInt(PROTOCOL_VERSION))],
    [2, encBstr(clientNonce)],
    [3, encText(idHint)],
    [4, encBstr(manifestPubFp)],
    [5, encBstr(sessionHmac)],
  ]);
  const chFrame = Buffer.concat([Buffer.from([OP_CLIENT_HELLO]), chBody]);
  const chHdr = Buffer.alloc(4);
  chHdr.writeUInt32BE(chFrame.length, 0);
  helperIn.write(Buffer.concat([chHdr, chFrame]));

  /* Stage 3 — write plaintext to argv-fd; helper memfd's it + seals. */
  argvFd.end(plaintext);

  /* Stage 4 — build BYOK_WRAP frame: CBOR + HMAC trailer.
   * Body: 1=request_id, 2=nonce, 3=provider, 4=plaintext_memfd_slot. */
  const requestId = 1n;
  const nonce = randomBytes(NONCE_BYTES);
  const body = encMap([
    [1, encUint(requestId)],
    [2, encBstr(nonce)],
    [3, encText(provider)],
    [4, encUint(0xFD00)],
  ]);
  const prefix = Buffer.concat([Buffer.from([OP_BYOK_WRAP]), body]);
  const bodyDigest = createHash("sha256").update(prefix).digest();
  const hmacInput = Buffer.alloc(SESSION_ID_BYTES + 8 + NONCE_BYTES + 8 + SHA256_BYTES);
  let off = 0;
  sessionId.copy(hmacInput, off); off += SESSION_ID_BYTES;
  hmacInput.writeBigUInt64BE(requestId, off); off += 8;
  nonce.copy(hmacInput, off); off += NONCE_BYTES;
  hmacInput.writeBigUInt64BE(peerInode, off); off += 8;
  bodyDigest.copy(hmacInput, off);
  const hmacTag = createHmac("sha256", hmacKey).update(hmacInput).digest()
    .subarray(0, HMAC_TAG_BYTES);
  const fullFrame = Buffer.concat([prefix, hmacTag]);
  const fullHdr = Buffer.alloc(4);
  fullHdr.writeUInt32BE(fullFrame.length, 0);
  frameFd.end(Buffer.concat([fullHdr, fullFrame]));

  /* Stage 5 — read BYOK_WRAP_RESP. */
  const resp = await recvOne();
  const respOp = resp[0]!;
  if (respOp === 0xff) {
    const m = parseMap(resp, 1);
    const errcode = (() => { try { return readUintEntry(m, 14); } catch { return 0; } })();
    const e = findEntry(m, 15);
    const msg = (e && e.major === 3) ? (e.value as string) : "byok_wrap rejected";
    throw new Error(`byokWrap denied: ${msg} (errcode=${errcode})`);
  }
  if (respOp !== OP_BYOK_WRAP_RESP) {
    throw new Error(`unexpected byokWrap resp opcode 0x${respOp.toString(16)}`);
  }
  const respMap = parseMap(resp, 1);
  const wrappedEntry = findEntry(respMap, 3);
  if (!wrappedEntry || wrappedEntry.major !== 2) {
    throw new Error("byokWrap response missing wrapped bstr");
  }
  /* Helper exits when daemon closes connection; let it. */
  return Buffer.from(wrappedEntry.value as Buffer);
}

async function connectInternal(
  path: string,
  project: string | null,
): Promise<EllulNamespacedClient | null> {
  let hmacKey: Buffer;
  let manifestPubFp: Buffer;
  try {
    hmacKey = deriveHmacKey();
    manifestPubFp = readManifestPubFingerprint();
  } catch (err) {
    logEvent("nsd.client.init-fail", { ...serializeError(err) });
    return null;
  }
  try {
    const socket = await connectUnix(path);
    /* `EllulNamespacedClient` is a private constructor — we re-enter it
     * here via its private hook. Cast through `unknown` is OK because
     * connectInternal is the only call site outside the class itself. */
    const client = new (EllulNamespacedClient as unknown as {
      new (s: Socket, p: string | null, k: Buffer, fp: Buffer): EllulNamespacedClient;
    })(socket, project, hmacKey, manifestPubFp);
    await (client as unknown as { handshake(): Promise<void> }).handshake();
    return client;
  } catch (err) {
    logEvent("nsd.attest.unreachable", {
      project: project ?? "admin",
      path,
      ...serializeError(err),
    });
    return null;
  }
}

// ── Minimal CBOR encoder ──────────────────────────────────

function encTypedUint(major: number, value: bigint | number): Buffer {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) throw new Error("encTypedUint: negative");
  if (v < 24n) return Buffer.from([(major << 5) | Number(v)]);
  if (v <= 0xffn) return Buffer.from([(major << 5) | 24, Number(v)]);
  if (v <= 0xffffn) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(Number(v), 1);
    return b;
  }
  if (v <= 0xffffffffn) {
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(Number(v), 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = (major << 5) | 27;
  b.writeBigUInt64BE(v, 1);
  return b;
}

function encUint(v: bigint | number): Buffer { return encTypedUint(0, v); }

function encBstr(b: Buffer): Buffer {
  return Buffer.concat([encTypedUint(2, b.length), b]);
}

function encText(s: string): Buffer {
  const buf = Buffer.from(s, "utf8");
  return Buffer.concat([encTypedUint(3, buf.length), buf]);
}

function encMap(entries: Array<[number, Buffer]>): Buffer {
  const parts: Buffer[] = [encTypedUint(5, entries.length)];
  for (const [k, v] of entries) {
    parts.push(encUint(k));
    parts.push(v);
  }
  return Buffer.concat(parts);
}

// ── Minimal CBOR decoder (just enough for response shapes) ─

interface DecodedValue {
  major: number;
  value: bigint | string | Buffer | DecodedValue[] | Array<[bigint, DecodedValue]> | null | boolean;
  size: number;
}

function decodeOne(buf: Buffer, offset: number): DecodedValue {
  if (offset >= buf.length) throw new Error("CBOR underflow");
  const first = buf[offset]!;
  const major = first >> 5;
  const ai = first & 0x1f;
  let value: bigint;
  let headerLen = 1;
  if (ai < 24) value = BigInt(ai);
  else if (ai === 24) { value = BigInt(buf[offset + 1]!); headerLen = 2; }
  else if (ai === 25) { value = BigInt(buf.readUInt16BE(offset + 1)); headerLen = 3; }
  else if (ai === 26) { value = BigInt(buf.readUInt32BE(offset + 1)); headerLen = 5; }
  else if (ai === 27) { value = buf.readBigUInt64BE(offset + 1); headerLen = 9; }
  else throw new Error(`CBOR indefinite/reserved ai=${ai}`);

  switch (major) {
    case 0: return { major, value, size: headerLen };
    case 1: return { major, value: -1n - value, size: headerLen };
    case 2: case 3: {
      const n = Number(value);
      const start = offset + headerLen;
      const slice = buf.subarray(start, start + n);
      if (slice.length !== n) throw new Error("CBOR string truncated");
      return { major, value: major === 3 ? slice.toString("utf8") : Buffer.from(slice), size: headerLen + n };
    }
    case 4: {
      const n = Number(value);
      let pos = offset + headerLen;
      const items: DecodedValue[] = [];
      for (let i = 0; i < n; i++) {
        const item = decodeOne(buf, pos);
        items.push(item);
        pos += item.size;
      }
      return { major, value: items, size: pos - offset };
    }
    case 5: {
      const n = Number(value);
      let pos = offset + headerLen;
      const entries: Array<[bigint, DecodedValue]> = [];
      for (let i = 0; i < n; i++) {
        const k = decodeOne(buf, pos);
        if (k.major !== 0) throw new Error("CBOR map key not uint");
        pos += k.size;
        const v = decodeOne(buf, pos);
        entries.push([k.value as bigint, v]);
        pos += v.size;
      }
      return { major, value: entries, size: pos - offset };
    }
    case 7: {
      if (ai === 20) return { major, value: false, size: 1 };
      if (ai === 21) return { major, value: true, size: 1 };
      if (ai === 22) return { major, value: null, size: 1 };
      throw new Error(`CBOR simple value ai=${ai} unsupported`);
    }
    default:
      throw new Error(`CBOR major ${major} unsupported`);
  }
}

function parseMap(frame: Buffer, offset: number): Array<[bigint, DecodedValue]> {
  const dec = decodeOne(frame, offset);
  if (dec.major !== 5) throw new Error("expected CBOR map");
  return dec.value as Array<[bigint, DecodedValue]>;
}

function findEntry(map: Array<[bigint, DecodedValue]>, key: number): DecodedValue | undefined {
  for (const [k, v] of map) if (k === BigInt(key)) return v;
  return undefined;
}

function readUintEntry(map: Array<[bigint, DecodedValue]>, key: number): number {
  const e = findEntry(map, key);
  if (!e || e.major !== 0) throw new Error(`missing/non-uint key ${key}`);
  return Number(e.value as bigint);
}

function readBstrEntry(map: Array<[bigint, DecodedValue]>, key: number): Buffer {
  const e = findEntry(map, key);
  if (!e || e.major !== 2) throw new Error(`missing/non-bstr key ${key}`);
  return e.value as Buffer;
}

function readBoolEntry(map: Array<[bigint, DecodedValue]>, key: number, dflt = false): boolean {
  const e = findEntry(map, key);
  if (!e) return dflt;
  if (e.major !== 7 || (typeof e.value !== "boolean")) throw new Error(`bad bool key ${key}`);
  return e.value;
}

function parseAttestResponse(frame: Buffer, expectedRequestId: bigint): AttestResult {
  if (frame.length < 2) return { ok: false, errorMessage: "short frame" };
  const op = frame[0]!;
  if (op !== OP_ATTEST_RESPONSE) {
    /* Could be a generic error frame (opcode 0xff). Map error fields. */
    if (op === 0xff) {
      const map = parseMap(frame, 1);
      const errcode = (() => { try { return readUintEntry(map, 14); } catch { return undefined; } })();
      let errorMessage: string | undefined;
      try {
        const e = findEntry(map, 15);
        if (e && e.major === 3) errorMessage = e.value as string;
      } catch { /* ignore */ }
      return { ok: false, errcode, errorMessage };
    }
    return { ok: false, errorMessage: `unexpected opcode 0x${op.toString(16)}` };
  }
  const map = parseMap(frame, 1);
  const rid = (() => { try { return BigInt(readUintEntry(map, 1)); } catch { return -1n; } })();
  if (rid !== expectedRequestId) return { ok: false, errorMessage: "request_id mismatch" };
  const matches = readBoolEntry(map, 2);
  const mismatchEntries: string[] = [];
  const arr = findEntry(map, 3);
  if (arr && arr.major === 4) {
    for (const item of arr.value as DecodedValue[]) {
      if (item.major === 3) mismatchEntries.push(item.value as string);
    }
  }
  let mountinfoDigest: string | undefined;
  const dig = findEntry(map, 4);
  if (dig && dig.major === 2) mountinfoDigest = (dig.value as Buffer).toString("hex");
  const anchorAlive = readBoolEntry(map, 5, false);
  return { ok: true, matches, mismatches: mismatchEntries, mountinfoDigest, anchorAlive };
}

function parseSetupResponse(frame: Buffer, expectedRequestId: bigint): SetupResult {
  if (frame.length < 2) return { ok: false, errorMessage: "short frame" };
  const op = frame[0]!;
  if (op === 0xff) {
    const map = parseMap(frame, 1);
    let errcode: number | undefined;
    try { errcode = readUintEntry(map, 14); } catch { /* ignore */ }
    let errorMessage: string | undefined;
    const e = findEntry(map, 15);
    if (e && e.major === 3) errorMessage = e.value as string;
    return { ok: false, errcode, errorMessage };
  }
  if (op !== OP_SETUP_RESPONSE) {
    return { ok: false, errorMessage: `unexpected opcode 0x${op.toString(16)}` };
  }
  const map = parseMap(frame, 1);
  const rid = (() => { try { return BigInt(readUintEntry(map, 1)); } catch { return -1n; } })();
  if (rid !== expectedRequestId) return { ok: false, errorMessage: "request_id mismatch" };
  const success = readBoolEntry(map, 2);
  let anchorPid: number | undefined;
  let unitName: string | undefined;
  let errcode: number | undefined;
  if (success) {
    try { anchorPid = readUintEntry(map, 3); } catch { /* ignore */ }
    const u = findEntry(map, 4);
    if (u && u.major === 3) unitName = u.value as string;
  }
  try { errcode = readUintEntry(map, 14); } catch { /* ignore */ }
  return { ok: true, success, anchorPid, unitName, errcode };
}

function parseTeardownResponse(frame: Buffer, expectedRequestId: bigint): TeardownResult {
  if (frame.length < 2) return { ok: false, errorMessage: "short frame" };
  const op = frame[0]!;
  if (op === 0xff) {
    const map = parseMap(frame, 1);
    let errcode: number | undefined;
    try { errcode = readUintEntry(map, 14); } catch { /* ignore */ }
    let errorMessage: string | undefined;
    const e = findEntry(map, 15);
    if (e && e.major === 3) errorMessage = e.value as string;
    return { ok: false, errcode, errorMessage };
  }
  if (op !== OP_TEARDOWN_RESPONSE) {
    return { ok: false, errorMessage: `unexpected opcode 0x${op.toString(16)}` };
  }
  const map = parseMap(frame, 1);
  const rid = (() => { try { return BigInt(readUintEntry(map, 1)); } catch { return -1n; } })();
  if (rid !== expectedRequestId) return { ok: false, errorMessage: "request_id mismatch" };
  const success = readBoolEntry(map, 2);
  let errcode: number | undefined;
  try { errcode = readUintEntry(map, 14); } catch { /* ignore */ }
  return { ok: true, success, errcode };
}

function parseAdminResponse(
  frame: Buffer,
  expectedRequestId: bigint,
  expectedResponseOp: number,
): AdminResult {
  if (frame.length < 2) return { ok: false, errorMessage: "short frame" };
  const op = frame[0]!;
  if (op === 0xff) {
    const map = parseMap(frame, 1);
    let errcode: number | undefined;
    try { errcode = readUintEntry(map, 14); } catch { /* ignore */ }
    let errorMessage: string | undefined;
    const e = findEntry(map, 15);
    if (e && e.major === 3) errorMessage = e.value as string;
    return { ok: false, errcode, errorMessage };
  }
  if (op !== expectedResponseOp) {
    return { ok: false, errorMessage: `unexpected opcode 0x${op.toString(16)}` };
  }
  const map = parseMap(frame, 1);
  const rid = (() => { try { return BigInt(readUintEntry(map, 1)); } catch { return -1n; } })();
  if (rid !== expectedRequestId) return { ok: false, errorMessage: "request_id mismatch" };
  const success = readBoolEntry(map, 2);
  let errcode: number | undefined;
  try { errcode = readUintEntry(map, 14); } catch { /* ignore */ }
  return { ok: success, errcode };
}

function parseHealthResponse(frame: Buffer, expectedRequestId: bigint): HealthResult {
  if (frame.length < 2) return { ok: false, errorMessage: "short frame" };
  if (frame[0] !== OP_HEALTH_RESPONSE) {
    return { ok: false, errorMessage: `unexpected opcode 0x${frame[0]!.toString(16)}` };
  }
  const map = parseMap(frame, 1);
  const rid = (() => { try { return BigInt(readUintEntry(map, 1)); } catch { return -1n; } })();
  if (rid !== expectedRequestId) return { ok: false, errorMessage: "request_id mismatch" };
  const ok = readBoolEntry(map, 2);
  const uptimeMs = readUintEntry(map, 3);
  const fpEntry = findEntry(map, 4);
  const manifestPubFp = (fpEntry && fpEntry.major === 2)
    ? (fpEntry.value as Buffer).toString("hex") : undefined;
  let features: number | undefined;
  try { features = readUintEntry(map, 5); } catch { /* optional */ }
  return { ok, uptimeMs, manifestPubFp, features };
}
