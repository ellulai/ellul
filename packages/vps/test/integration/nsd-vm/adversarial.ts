// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// adversarial.ts — port of red-team.sh into TypeScript, with assertions on
// the daemon's event-log shape after each attack. Runs inside the bridge
// cgroup; for the out-of-cgroup denial test it forks a helper into a
// non-bridge slice via sudo systemd-run.
//
// Cases:
//   1. Connection from outside bridge cgroup           → nsd.auth.deny cgroup-mismatch
//   2. Malformed CBOR frame                            → daemon closes, no crash
//   3. Oversize frame (length prefix > 64 KiB)         → daemon closes, no crash
//   4. Bad HMAC trailer on a valid CBOR frame          → nsd.auth.deny hmac
//   5. Replayed request_id (monotonic violation)       → nsd.replay.deny
//   6. Wrong manifest fingerprint in CLIENT_HELLO      → connection closed
//
// After all attacks, asserts:
//   - ellul-namespaced.service is still active (no daemon crash)
//   - Each expected nsd.{auth,replay}.deny tag is present at least once
//   - No nsd.attest.* / nsd.setup.* tags fired (we did none of those)

import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";

import { expectEvent, expectNoEvent, readEventsSince } from "./event-log.js";

const ADMIN_SOCK = "/run/ellul-ns/admin.sock";
const HMAC_KEY_INPUT_PATH = "/etc/machine-id";
const MANIFEST_PUB_PATH = "/etc/ellul/manifests/manifest.pub";
const HMAC_LABEL = "ellul-namespaced-v1";

const PROTOCOL_VERSION = 1;
const NONCE_BYTES = 16;
const HMAC_TAG_BYTES = 16;
const FINGERPRINT_BYTES = 32;
const SESSION_ID_BYTES = 16;
const SHA256_BYTES = 32;
const MAX_FRAME_BYTES = 64 * 1024;

const OP_HELLO = 0x01;
const OP_CLIENT_HELLO = 0x02;
const OP_HEALTH = 0x10;
const OP_HEALTH_RESPONSE = 0x11;

interface DecodedValue {
  major: number;
  value:
    | bigint
    | string
    | Buffer
    | DecodedValue[]
    | Array<[bigint, DecodedValue]>
    | null
    | boolean;
  size: number;
}

function deriveHmacKey(): Buffer {
  const machineId = fs.readFileSync(HMAC_KEY_INPUT_PATH, "utf8").trim();
  return createHash("sha256")
    .update(Buffer.from(`${HMAC_LABEL}\0`, "utf8"))
    .update(Buffer.from(machineId, "utf8"))
    .digest();
}

function readManifestFp(): Buffer {
  const raw = fs.readFileSync(MANIFEST_PUB_PATH);
  let pub: Buffer;
  if (raw.length === 32) pub = raw;
  else {
    const hex = raw.toString("ascii").replace(/\s+/g, "");
    if (hex.length !== 64) throw new Error("manifest.pub: bad shape");
    pub = Buffer.from(hex, "hex");
  }
  return createHash("sha256").update(pub).digest();
}

function encTypedUint(major: number, value: bigint | number): Buffer {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) throw new Error("negative");
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

const encUint = (v: number | bigint) => encTypedUint(0, v);
const encBstr = (b: Buffer) => Buffer.concat([encTypedUint(2, b.length), b]);
const encText = (s: string) => {
  const buf = Buffer.from(s, "utf8");
  return Buffer.concat([encTypedUint(3, buf.length), buf]);
};
function encMap(entries: Array<[number, Buffer]>): Buffer {
  const parts: Buffer[] = [encTypedUint(5, entries.length)];
  for (const [k, v] of entries) {
    parts.push(encUint(k));
    parts.push(v);
  }
  return Buffer.concat(parts);
}

function decodeOne(buf: Buffer, offset: number): DecodedValue {
  if (offset >= buf.length) throw new Error("CBOR underflow");
  const first = buf[offset]!;
  const major = first >> 5;
  const ai = first & 0x1f;
  let value: bigint;
  let headerLen = 1;
  if (ai < 24) value = BigInt(ai);
  else if (ai === 24) {
    value = BigInt(buf[offset + 1]!);
    headerLen = 2;
  } else if (ai === 25) {
    value = BigInt(buf.readUInt16BE(offset + 1));
    headerLen = 3;
  } else if (ai === 26) {
    value = BigInt(buf.readUInt32BE(offset + 1));
    headerLen = 5;
  } else if (ai === 27) {
    value = buf.readBigUInt64BE(offset + 1);
    headerLen = 9;
  } else throw new Error(`CBOR ai=${ai}`);
  switch (major) {
    case 0:
      return { major, value, size: headerLen };
    case 2:
    case 3: {
      const n = Number(value);
      const start = offset + headerLen;
      const slice = buf.subarray(start, start + n);
      return {
        major,
        value: major === 3 ? slice.toString("utf8") : Buffer.from(slice),
        size: headerLen + n,
      };
    }
    case 5: {
      const n = Number(value);
      let pos = offset + headerLen;
      const entries: Array<[bigint, DecodedValue]> = [];
      for (let i = 0; i < n; i++) {
        const k = decodeOne(buf, pos);
        if (k.major !== 0) throw new Error("map key not uint");
        pos += k.size;
        const v = decodeOne(buf, pos);
        entries.push([k.value as bigint, v]);
        pos += v.size;
      }
      return { major, value: entries, size: pos - offset };
    }
    default:
      throw new Error(`major ${major} unsupported`);
  }
}

function parseMap(frame: Buffer, offset: number): Array<[bigint, DecodedValue]> {
  const dec = decodeOne(frame, offset);
  if (dec.major !== 5) throw new Error("expected map");
  return dec.value as Array<[bigint, DecodedValue]>;
}
function findEntry(
  m: Array<[bigint, DecodedValue]>,
  k: number,
): DecodedValue | undefined {
  for (const [kk, v] of m) if (kk === BigInt(k)) return v;
  return undefined;
}
function readBstr(m: Array<[bigint, DecodedValue]>, k: number): Buffer {
  const e = findEntry(m, k);
  if (!e || e.major !== 2) throw new Error(`missing bstr ${k}`);
  return e.value as Buffer;
}

interface Session {
  hmacKey: Buffer;
  manifestFp: Buffer;
  serverNonce: Buffer;
  sessionId: Buffer;
  peerPidfdInode: bigint;
  nextRequestId: bigint;
}

async function readFrame(sock: Socket, timeoutMs = 5_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("frame timeout")), timeoutMs);
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (len === 0 || len > MAX_FRAME_BYTES) {
        clearTimeout(timer);
        sock.off("data", onData);
        reject(new Error(`bad frame length ${len}`));
        return;
      }
      if (buf.length < 4 + len) return;
      const frame = Buffer.from(buf.subarray(4, 4 + len));
      buf = buf.subarray(4 + len);
      clearTimeout(timer);
      sock.off("data", onData);
      resolve(frame);
    };
    sock.on("data", onData);
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.once("close", () => {
      clearTimeout(timer);
      reject(new Error("socket closed before frame"));
    });
  });
}

function writeFrame(sock: Socket, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32BE(frame.length, 0);
    sock.write(Buffer.concat([hdr, frame]), (err) => (err ? reject(err) : resolve()));
  });
}

function connectUnix(path: string, timeoutMs = 2_000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`connect timeout ${path}`));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function handshake(sock: Socket, hmacKey: Buffer, manifestFp: Buffer): Promise<Session> {
  const hello = await readFrame(sock);
  if (hello[0] !== OP_HELLO) throw new Error(`expected HELLO, got 0x${hello[0]!.toString(16)}`);
  const map = parseMap(hello, 1);
  const serverNonce = readBstr(map, 2);
  const fpEntry = readBstr(map, 3);
  const sessionId = readBstr(map, 4);
  const inodeEntry = findEntry(map, 6);
  if (!inodeEntry || inodeEntry.major !== 0) throw new Error("missing peer_pidfd_inode");
  if (!timingSafeEqual(fpEntry, manifestFp)) throw new Error("fp mismatch");

  const clientNonce = randomBytes(NONCE_BYTES);
  const idHint = `adversarial:${process.pid}`;
  const sessionHmac = createHmac("sha256", hmacKey)
    .update(serverNonce)
    .update(clientNonce)
    .update(Buffer.from(idHint, "utf8"))
    .digest()
    .subarray(0, HMAC_TAG_BYTES);
  const body = encMap([
    [1, encUint(BigInt(PROTOCOL_VERSION))],
    [2, encBstr(clientNonce)],
    [3, encText(idHint)],
    [4, encBstr(manifestFp)],
    [5, encBstr(sessionHmac)],
  ]);
  await writeFrame(sock, Buffer.concat([Buffer.from([OP_CLIENT_HELLO]), body]));
  return {
    hmacKey,
    manifestFp,
    serverNonce,
    sessionId,
    peerPidfdInode: inodeEntry.value as bigint,
    nextRequestId: 1n,
  };
}

function buildHealthFrame(s: Session, requestIdOverride?: bigint, hmacOverride?: Buffer): Buffer {
  const requestId = requestIdOverride ?? s.nextRequestId++;
  const nonce = randomBytes(NONCE_BYTES);
  const body = encMap([
    [1, encUint(requestId)],
    [2, encBstr(nonce)],
  ]);
  const prefix = Buffer.concat([Buffer.from([OP_HEALTH]), body]);
  const bodyDigest = createHash("sha256").update(prefix).digest();
  const hi = Buffer.alloc(SESSION_ID_BYTES + 8 + NONCE_BYTES + 8 + SHA256_BYTES);
  let off = 0;
  s.sessionId.copy(hi, off);
  off += SESSION_ID_BYTES;
  hi.writeBigUInt64BE(requestId, off);
  off += 8;
  nonce.copy(hi, off);
  off += NONCE_BYTES;
  hi.writeBigUInt64BE(s.peerPidfdInode, off);
  off += 8;
  bodyDigest.copy(hi, off);
  const tag = hmacOverride
    ?? createHmac("sha256", s.hmacKey).update(hi).digest().subarray(0, HMAC_TAG_BYTES);
  return Buffer.concat([prefix, tag]);
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`[adversarial] ${label} … `);
  const t0 = Date.now();
  try {
    const v = await fn();
    process.stdout.write(`ok (${Date.now() - t0}ms)\n`);
    return v;
  } catch (err) {
    process.stdout.write(`FAIL (${Date.now() - t0}ms)\n`);
    throw err;
  }
}

function daemonAlive(): boolean {
  const r = spawnSync("systemctl", ["is-active", "ellul-namespaced.service"]);
  return r.status === 0 && r.stdout.toString().trim() === "active";
}

async function main(): Promise<void> {
  const startedAtMs = Date.now();
  const hmacKey = deriveHmacKey();
  const manifestFp = readManifestFp();

  // ── Case 1: out-of-bridge-cgroup connect via sudo systemd-run ──
  // We're inside the bridge cgroup; spawn a helper into user.slice via
  // sudo systemd-run --scope so its peer cgroup fails the daemon's gate.
  await step("out-of-cgroup connect denied", async () => {
    const helper = `
const net = require("node:net");
const sock = net.connect("${ADMIN_SOCK}");
let result = "open";
sock.on("connect", () => { /* may close right after */ });
sock.on("data", () => { result = "data"; sock.destroy(); });
sock.on("close", () => { console.log(JSON.stringify({ result })); process.exit(0); });
sock.on("error", (e) => { console.log(JSON.stringify({ result: "error", code: e.code })); process.exit(0); });
setTimeout(() => { sock.destroy(); console.log(JSON.stringify({ result: "timeout" })); process.exit(0); }, 2000);
`;
    const r = spawnSync(
      "sudo",
      [
        "systemd-run",
        "--scope",
        "--quiet",
        "--slice=user.slice",
        "--uid=" + (process.getuid?.() ?? 1000),
        "--",
        process.execPath,
        "-e",
        helper,
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) {
      throw new Error(`sudo systemd-run failed: ${r.stderr || r.stdout}`);
    }
    const lines = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"));
    if (lines.length === 0) {
      throw new Error(`helper produced no JSON: stdout=${r.stdout} stderr=${r.stderr}`);
    }
    const parsed = JSON.parse(lines[lines.length - 1]!);
    /* Daemon closes the connection silently after auth fails. The peer
     * either sees the close cleanly or never gets HELLO. Either way it
     * must NOT have read a frame. */
    if (parsed.result === "data") {
      throw new Error("out-of-cgroup peer received data — auth gate broken");
    }
  });

  // ── Case 2: malformed CBOR frame ──
  await step("malformed CBOR frame", async () => {
    const sock = await connectUnix(ADMIN_SOCK);
    try {
      const session = await handshake(sock, hmacKey, manifestFp);
      // Send a frame whose CBOR body is truncated mid-map. Daemon must
      // close cleanly; we treat an immediate close as success.
      const body = Buffer.from([0xa1]); /* map(1) header, no key/value */
      const garbage = Buffer.concat([
        Buffer.from([OP_HEALTH]),
        body,
        Buffer.alloc(HMAC_TAG_BYTES),
      ]);
      await writeFrame(sock, garbage);
      // Either we get a generic-error frame (opcode 0xff) or close. Both ok.
      try {
        await readFrame(sock, 2_000);
      } catch {
        /* Close before frame is acceptable. */
      }
      void session;
    } finally {
      sock.destroy();
    }
  });

  // ── Case 3: oversize frame ──
  await step("oversize frame closes connection", async () => {
    const sock = await connectUnix(ADMIN_SOCK);
    try {
      // Length prefix over the cap; daemon must EPROTO and close.
      const hdr = Buffer.alloc(4);
      hdr.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
      sock.write(hdr);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("oversize: socket did not close")), 3_000);
        sock.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        sock.once("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      sock.destroy();
    }
  });

  // ── Case 4: bad HMAC trailer on a valid frame ──
  await step("bad HMAC denied", async () => {
    const sock = await connectUnix(ADMIN_SOCK);
    try {
      const s = await handshake(sock, hmacKey, manifestFp);
      const wrongHmac = randomBytes(HMAC_TAG_BYTES);
      const frame = buildHealthFrame(s, undefined, wrongHmac);
      await writeFrame(sock, frame);
      // Daemon emits nsd.auth.deny + closes the conn.
      try {
        await readFrame(sock, 2_000);
      } catch {
        /* close acceptable */
      }
    } finally {
      sock.destroy();
    }
  });

  // ── Case 5: replay (request_id <= last seen) ──
  await step("replay denied", async () => {
    const sock = await connectUnix(ADMIN_SOCK);
    try {
      const s = await handshake(sock, hmacKey, manifestFp);
      // Send a normal HEALTH frame to advance last_request_id.
      const goodFrame = buildHealthFrame(s);
      await writeFrame(sock, goodFrame);
      const resp = await readFrame(sock);
      if (resp[0] !== OP_HEALTH_RESPONSE) {
        throw new Error(`expected HEALTH_RESPONSE, got 0x${resp[0]!.toString(16)}`);
      }
      // Now replay with the SAME request_id (1n). Daemon must EREPLAY.
      const replay = buildHealthFrame(s, 1n);
      await writeFrame(sock, replay);
      try {
        await readFrame(sock, 2_000);
      } catch {
        /* close acceptable */
      }
    } finally {
      sock.destroy();
    }
  });

  // ── Case 6: wrong manifest fingerprint in CLIENT_HELLO ──
  await step("wrong manifest fingerprint denied", async () => {
    const sock = await connectUnix(ADMIN_SOCK);
    try {
      const hello = await readFrame(sock);
      if (hello[0] !== OP_HELLO) throw new Error("no HELLO");
      const map = parseMap(hello, 1);
      const serverNonce = readBstr(map, 2);
      const clientNonce = randomBytes(NONCE_BYTES);
      const idHint = `adversarial-bad-fp:${process.pid}`;
      const sessionHmac = createHmac("sha256", hmacKey)
        .update(serverNonce)
        .update(clientNonce)
        .update(Buffer.from(idHint, "utf8"))
        .digest()
        .subarray(0, HMAC_TAG_BYTES);
      const wrongFp = Buffer.alloc(FINGERPRINT_BYTES, 0xff);
      const body = encMap([
        [1, encUint(BigInt(PROTOCOL_VERSION))],
        [2, encBstr(clientNonce)],
        [3, encText(idHint)],
        [4, encBstr(wrongFp)],
        [5, encBstr(sessionHmac)],
      ]);
      await writeFrame(sock, Buffer.concat([Buffer.from([OP_CLIENT_HELLO]), body]));
      // Daemon should drop the connection without a response.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("daemon did not close")), 3_000);
        sock.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        sock.once("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      sock.destroy();
    }
  });

  // ── Daemon liveness check ──
  if (!daemonAlive()) {
    throw new Error("ellul-namespaced.service is no longer active after attacks");
  }

  // ── Event-log assertions ──
  const events = readEventsSince(startedAtMs);

  expectEvent(
    events,
    (e) =>
      e.event === "nsd.auth.deny" &&
      typeof e.reason === "string" &&
      e.reason === "cgroup-mismatch",
    "nsd.auth.deny cgroup-mismatch",
  );
  expectEvent(
    events,
    (e) =>
      e.event === "nsd.auth.deny" &&
      typeof e.reason === "string" &&
      e.reason === "hmac",
    "nsd.auth.deny hmac",
  );
  expectEvent(events, (e) => e.event === "nsd.replay.deny", "nsd.replay.deny");

  /* No SETUP / ATTEST / TEARDOWN occurred during adversarial — make sure
   * a hostile probe didn't accidentally drive an admin op. */
  expectNoEvent(events, (e) => e.event === "nsd.setup.ok", "nsd.setup.ok");
  expectNoEvent(events, (e) => e.event === "nsd.attest.ok", "nsd.attest.ok");
  expectNoEvent(events, (e) => e.event === "nsd.teardown.ok", "nsd.teardown.ok");

  process.stdout.write(`[adversarial] all attacks contained (${Date.now() - startedAtMs}ms)\n`);
}

main().catch((err) => {
  process.stderr.write(`[adversarial] FAIL: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
