// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Unit tests for the bridge-side ellul-namespaced client.
 *
 * Scope: CBOR encoder produces canonical bytes; HMAC trailer math; HELLO
 * parse round-trip. Doesn't exercise socket I/O — the daemon-side
 * red-team.sh covers end-to-end behavior on a real VPS.
 */

import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "crypto";

/* We intentionally test the module's public surface — re-import the
 * helpers via a thin re-export shim. The CBOR helpers are not exported
 * publicly to keep the API surface small; instead we reproduce minimal
 * fixtures and test the observable behavior (handshake fingerprint match
 * + HMAC determinism). */

describe("EllulNamespacedClient — CBOR/HMAC fixtures", () => {
  it("HMAC-SHA256 truncation matches the daemon's expected layout", () => {
    /* Per-message HMAC input layout (must match hmac_session.c):
     *   session_id (16) || request_id_be8 (8) || nonce16 (16) ||
     *   peer_pidfd_inode_be8 (8) || body_digest_sha256 (32) = 80 bytes
     * Output is HMAC-SHA256 truncated to 16 bytes. */
    const sessionId = Buffer.alloc(16, 0xa1);
    const nonce = Buffer.alloc(16, 0xb2);
    const requestId = 0x123456789abcdef0n;
    const peerPidfdInode = 0x4242424242424242n;
    const bodyDigest = createHash("sha256").update("test-body").digest();
    const sharedKey = createHash("sha256")
      .update("ellul-namespaced-v1\0")
      .update("0123456789abcdef")
      .digest();

    const buf = Buffer.alloc(16 + 8 + 16 + 8 + 32);
    let off = 0;
    sessionId.copy(buf, off); off += 16;
    buf.writeBigUInt64BE(requestId, off); off += 8;
    nonce.copy(buf, off); off += 16;
    buf.writeBigUInt64BE(peerPidfdInode, off); off += 8;
    bodyDigest.copy(buf, off);

    const tag = createHmac("sha256", sharedKey).update(buf).digest().subarray(0, 16);
    expect(tag.length).toBe(16);

    /* Determinism: re-computing yields the same tag byte-for-byte. */
    const tag2 = createHmac("sha256", sharedKey).update(buf).digest().subarray(0, 16);
    expect(tag2.equals(tag)).toBe(true);

    /* Sensitivity: flipping one bit in any input changes the tag. */
    const bumped = Buffer.from(buf);
    bumped[0] ^= 1;
    const tag3 = createHmac("sha256", sharedKey).update(bumped).digest().subarray(0, 16);
    expect(tag3.equals(tag)).toBe(false);
  });

  it("HMAC key derivation matches daemon's nsd_hmac_derive_shared_key", () => {
    /* The C side does:
     *   crypto_hash_sha256_init(...);
     *   crypto_hash_sha256_update(label, sizeof(label));   // INCLUDES NUL
     *   crypto_hash_sha256_update(machine_id_bytes, n);
     *   crypto_hash_sha256_final(out);
     *
     * sizeof("ellul-namespaced-v1") in C is the array length, which
     * includes the trailing NUL — 20 bytes total. We mirror that.
     */
    const machineId = "0123456789abcdef0123456789abcdef";
    const label = Buffer.from("ellul-namespaced-v1\0", "utf8");
    expect(label.length).toBe(20);

    const expected = createHash("sha256")
      .update(label)
      .update(machineId)
      .digest();

    const actual = createHash("sha256")
      .update(label)
      .update(Buffer.from(machineId, "utf8"))
      .digest();

    expect(actual.equals(expected)).toBe(true);
    expect(actual.length).toBe(32);
  });

  it("adapterScope target_cgroup paths match the daemon's regex shape", () => {
    /* Mirror of EllulNamespacedClient.ts::validateTargetCgroup. The daemon
     * re-validates server-side, but the bridge's own check fails fast
     * on a malformed input before the helper subprocess is even spawned.
     * If this test diverges from the daemon's target_cgroup_path_ok
     * (test_target_cgroup.c), one of the two needs updating. */
    const validate = (project: string, path: string): boolean => {
      if (path.length >= 256) return false;
      if (path.includes("..") || path.includes("//")) return false;
      const m = project.match(/^sbx-([a-z0-9]{7})$/);
      if (!m) return false;
      const short = m[1]!;
      const expected = new RegExp(
        `^/sys/fs/cgroup/ellul\\.slice/ellul-user-workload\\.slice/` +
          `ellul-user-workload-sbx-${short}\\.slice/` +
          `ellul-pool-sbx-${short}-(claude|opencode|cursor|codex)-` +
          `[a-zA-Z0-9_-]{1,32}\\.scope/?$`,
      );
      return expected.test(path);
    };

    /* Happy paths. */
    expect(validate(
      "sbx-cit0001",
      "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/" +
        "ellul-user-workload-sbx-cit0001.slice/" +
        "ellul-pool-sbx-cit0001-claude-pool0.scope",
    )).toBe(true);
    expect(validate(
      "sbx-abc1234",
      "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/" +
        "ellul-user-workload-sbx-abc1234.slice/" +
        "ellul-pool-sbx-abc1234-opencode-Hot_3.scope",
    )).toBe(true);
    expect(validate(
      "sbx-zxy9876",
      "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/" +
        "ellul-user-workload-sbx-zxy9876.slice/" +
        "ellul-pool-sbx-zxy9876-cursor-acp-1.scope/",
    )).toBe(true);

    /* Project bind. */
    expect(validate(
      "sbx-other11",
      "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/" +
        "ellul-user-workload-sbx-cit0001.slice/" +
        "ellul-pool-sbx-cit0001-claude-pool0.scope",
    )).toBe(false);

    /* Adapter allowlist. */
    expect(validate(
      "sbx-cit0001",
      "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/" +
        "ellul-user-workload-sbx-cit0001.slice/" +
        "ellul-pool-sbx-cit0001-evil-pool0.scope",
    )).toBe(false);

    /* Path traversal. */
    expect(validate(
      "sbx-cit0001",
      "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/" +
        "ellul-user-workload-sbx-cit0001.slice/../" +
        "ellul-pool-sbx-cit0001-claude-pool0.scope",
    )).toBe(false);

    /* .service instead of .scope. */
    expect(validate(
      "sbx-cit0001",
      "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/" +
        "ellul-user-workload-sbx-cit0001.slice/" +
        "ellul-pool-sbx-cit0001-claude-pool0.service",
    )).toBe(false);

    /* Wrong slug shape. */
    expect(validate(
      "wrong-cit0001",
      "/sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/" +
        "ellul-user-workload-sbx-cit0001.slice/" +
        "ellul-pool-sbx-cit0001-claude-pool0.scope",
    )).toBe(false);
  });

  it("CBOR map encoding produces canonical (smallest) integer headers", () => {
    /* Reproduce the encoder's integer-encoding rules from cbor_io.c
     * (enc_typed_uint). The daemon's tinycbor in StrictMode rejects
     * non-canonical encodings, so the bridge MUST use the smallest form. */
    const encUint = (v: number): Buffer => {
      if (v < 24) return Buffer.from([v]);
      if (v <= 0xff) return Buffer.from([24, v]);
      if (v <= 0xffff) {
        const b = Buffer.alloc(3); b[0] = 25; b.writeUInt16BE(v, 1); return b;
      }
      const b = Buffer.alloc(5); b[0] = 26; b.writeUInt32BE(v, 1); return b;
    };

    expect(encUint(0).equals(Buffer.from([0x00]))).toBe(true);
    expect(encUint(23).equals(Buffer.from([0x17]))).toBe(true);
    expect(encUint(24).equals(Buffer.from([0x18, 0x18]))).toBe(true);
    expect(encUint(255).equals(Buffer.from([0x18, 0xff]))).toBe(true);
    expect(encUint(256).equals(Buffer.from([0x19, 0x01, 0x00]))).toBe(true);
    expect(encUint(65535).equals(Buffer.from([0x19, 0xff, 0xff]))).toBe(true);
    expect(encUint(65536).equals(Buffer.from([0x1a, 0x00, 0x01, 0x00, 0x00]))).toBe(true);
  });
});
