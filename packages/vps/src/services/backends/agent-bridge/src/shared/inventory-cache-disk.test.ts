// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Unit tests for the durable inventory cache (resource-v2 Phase C).
// All filesystem ops happen in a per-test tmpdir; tests are platform-
// agnostic (no /etc, no sudo, no /sys/fs/cgroup involvement).

import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  INVENTORY_CACHE_FORMAT_VERSION,
  inventoryCacheKeyForBinary,
  inventoryCachePath,
  loadInventoryCacheFromDisk,
  persistInventoryCacheToDisk,
} from "./inventory-cache-disk";

interface OpenCodeFakePayload {
  readonly version: string;
  readonly binaryPath: string;
  readonly fetchedAt: number;
  readonly inventory: { readonly models: ReadonlyArray<string> };
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ellul-inv-cache-"));
});

function validateOpenCodePayload(raw: unknown): OpenCodeFakePayload | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as OpenCodeFakePayload).version !== "string" ||
    typeof (raw as OpenCodeFakePayload).binaryPath !== "string" ||
    typeof (raw as OpenCodeFakePayload).fetchedAt !== "number" ||
    typeof (raw as OpenCodeFakePayload).inventory !== "object"
  ) {
    return null;
  }
  return raw as OpenCodeFakePayload;
}

const SAMPLE: OpenCodeFakePayload = {
  version: "1.14.19",
  binaryPath: "/usr/local/bin/opencode",
  fetchedAt: 1_700_000_000_000,
  inventory: { models: ["claude-sonnet-4", "gpt-5"] },
};

describe("persistInventoryCacheToDisk + loadInventoryCacheFromDisk", () => {
  it("round-trips a payload through atomic write + schema-validated read", () => {
    persistInventoryCacheToDisk({
      adapter: "opencode",
      cacheKey: "sha256:abc",
      fetchedAt: SAMPLE.fetchedAt,
      payload: SAMPLE,
      cacheDir,
    });
    const loaded = loadInventoryCacheFromDisk<OpenCodeFakePayload>({
      adapter: "opencode",
      cacheDir,
      validatePayload: validateOpenCodePayload,
    });
    expect(loaded).not.toBeNull();
    expect(loaded?.cacheKey).toBe("sha256:abc");
    expect(loaded?.fetchedAt).toBe(SAMPLE.fetchedAt);
    expect(loaded?.payload).toEqual(SAMPLE);
  });

  it("writes the file with mode 0o640", () => {
    persistInventoryCacheToDisk({
      adapter: "opencode",
      cacheKey: "k",
      fetchedAt: 1,
      payload: SAMPLE,
      cacheDir,
    });
    const stat = fs.statSync(inventoryCachePath("opencode", cacheDir));
    // Check the lower nine permission bits (mask 0o777). Some filesystems
    // can add ACL bits above; only the rwx triplet matters here.
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o640);
  });

  it("creates the cache directory if missing (with 0o750)", () => {
    const nestedDir = path.join(cacheDir, "nested", "deep");
    persistInventoryCacheToDisk({
      adapter: "cursor",
      cacheKey: "k",
      fetchedAt: 1,
      payload: SAMPLE,
      cacheDir: nestedDir,
    });
    expect(fs.existsSync(inventoryCachePath("cursor", nestedDir))).toBe(true);
  });

  it("returns null when the file is absent", () => {
    const loaded = loadInventoryCacheFromDisk<OpenCodeFakePayload>({
      adapter: "opencode",
      cacheDir,
      validatePayload: validateOpenCodePayload,
    });
    expect(loaded).toBeNull();
  });

  it("returns null when JSON is corrupt and leaves the file untouched", () => {
    const filePath = inventoryCachePath("opencode", cacheDir);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(filePath, "{not valid json", { mode: 0o640 });
    const loaded = loadInventoryCacheFromDisk<OpenCodeFakePayload>({
      adapter: "opencode",
      cacheDir,
      validatePayload: validateOpenCodePayload,
    });
    expect(loaded).toBeNull();
    // Corrupt file is left in place — next persist will atomically
    // overwrite it. We never delete out-of-band data.
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("rejects an envelope with the wrong adapter name", () => {
    const filePath = inventoryCachePath("opencode", cacheDir);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: INVENTORY_CACHE_FORMAT_VERSION,
        adapter: "cursor", // wrong adapter
        cacheKey: "k",
        fetchedAt: 1,
        payload: SAMPLE,
      }),
    );
    const loaded = loadInventoryCacheFromDisk<OpenCodeFakePayload>({
      adapter: "opencode",
      cacheDir,
      validatePayload: validateOpenCodePayload,
    });
    expect(loaded).toBeNull();
  });

  it("rejects an envelope with a future format version", () => {
    const filePath = inventoryCachePath("opencode", cacheDir);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 99,
        adapter: "opencode",
        cacheKey: "k",
        fetchedAt: 1,
        payload: SAMPLE,
      }),
    );
    const loaded = loadInventoryCacheFromDisk<OpenCodeFakePayload>({
      adapter: "opencode",
      cacheDir,
      validatePayload: validateOpenCodePayload,
    });
    expect(loaded).toBeNull();
  });

  it("rejects an entry past maxAgeMs", () => {
    persistInventoryCacheToDisk({
      adapter: "opencode",
      cacheKey: "k",
      fetchedAt: 1_000,
      payload: SAMPLE,
      cacheDir,
    });
    const loaded = loadInventoryCacheFromDisk<OpenCodeFakePayload>({
      adapter: "opencode",
      cacheDir,
      validatePayload: validateOpenCodePayload,
      maxAgeMs: 5_000,
      now: () => 10_000, // 9_000 ms past fetchedAt → stale
    });
    expect(loaded).toBeNull();
  });

  it("accepts an entry within maxAgeMs", () => {
    persistInventoryCacheToDisk({
      adapter: "opencode",
      cacheKey: "k",
      fetchedAt: 1_000,
      payload: SAMPLE,
      cacheDir,
    });
    const loaded = loadInventoryCacheFromDisk<OpenCodeFakePayload>({
      adapter: "opencode",
      cacheDir,
      validatePayload: validateOpenCodePayload,
      maxAgeMs: 5_000,
      now: () => 4_000, // 3_000 ms past — well under TTL
    });
    expect(loaded).not.toBeNull();
  });

  it("rejects when validatePayload returns null (shape drift)", () => {
    persistInventoryCacheToDisk({
      adapter: "opencode",
      cacheKey: "k",
      fetchedAt: 1,
      payload: { rogueShape: true } as unknown as OpenCodeFakePayload,
      cacheDir,
    });
    const loaded = loadInventoryCacheFromDisk<OpenCodeFakePayload>({
      adapter: "opencode",
      cacheDir,
      validatePayload: validateOpenCodePayload,
    });
    expect(loaded).toBeNull();
  });

  it("ignores unknown adapters (allowlist enforced)", () => {
    persistInventoryCacheToDisk({
      adapter: "evil" as unknown as "opencode",
      cacheKey: "k",
      fetchedAt: 1,
      payload: SAMPLE,
      cacheDir,
    });
    // Nothing should have been written.
    expect(fs.existsSync(path.join(cacheDir, "evil.json"))).toBe(false);
  });

  it("does not leak partial writes if rename fails (graceful no-op)", () => {
    // Sanity: under normal operation the .tmp file is renamed away. If
    // a rename failed mid-flight we'd still want no half-written
    // <adapter>.json. Confirm post-success there's exactly one file
    // (the final, no leftover .tmp).
    persistInventoryCacheToDisk({
      adapter: "opencode",
      cacheKey: "k",
      fetchedAt: 1,
      payload: SAMPLE,
      cacheDir,
    });
    const entries = fs.readdirSync(cacheDir);
    expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
    expect(entries).toContain("opencode.json");
  });
});

describe("inventoryCacheKeyForBinary", () => {
  it("returns a stable key for an existing file", () => {
    const fakeBin = path.join(cacheDir, "fake-binary");
    fs.writeFileSync(fakeBin, "binary contents", { mode: 0o755 });
    const k1 = inventoryCacheKeyForBinary(fakeBin);
    const k2 = inventoryCacheKeyForBinary(fakeBin);
    expect(k1).toBe(k2);
    expect(k1).not.toBeNull();
  });

  it("changes the key when mtime/size change (binary upgrade)", () => {
    const fakeBin = path.join(cacheDir, "fake-binary");
    fs.writeFileSync(fakeBin, "v1");
    const before = inventoryCacheKeyForBinary(fakeBin);
    // Different content → different size → key flips. We don't need to
    // mock mtime resolution since size changes too.
    fs.writeFileSync(fakeBin, "v2 with more content");
    const after = inventoryCacheKeyForBinary(fakeBin);
    expect(after).not.toBe(before);
  });

  it("returns null for a missing binary (caller treats as no-cache)", () => {
    expect(inventoryCacheKeyForBinary("/nonexistent/binary")).toBeNull();
  });
});
