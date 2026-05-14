// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Filesystem-backed StoreRepository.
 *
 * Atomic writes via tmp + rename — partial writes are impossible on POSIX
 * because rename is atomic at the inode level. On startup, missing or
 * unparseable file → seed an empty store (caller decides whether to log
 * a recovery alert).
 */

import * as fs from "fs";
import type { StoreRepository } from "../application/ports";
import { type ClaudeOatStoreV1, emptyStore } from "../domain/store";

const STORE_MODE = 0o640;

export class FilesystemStoreRepository implements StoreRepository {
  private cached: ClaudeOatStoreV1 | null = null;

  constructor(
    private readonly storePath: string,
    private readonly dataDir: string,
  ) {}

  load(): ClaudeOatStoreV1 {
    if (this.cached) return this.cached;
    try {
      const raw = fs.readFileSync(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as ClaudeOatStoreV1;
      if (parsed.version !== 1) {
        throw new Error(
          `Unsupported claude-oat store version: ${parsed.version}`,
        );
      }
      this.cached = parsed;
      return parsed;
    } catch {
      const seeded = emptyStore();
      this.save(seeded);
      return seeded;
    }
  }

  save(store: ClaudeOatStoreV1): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.storePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: STORE_MODE });
    fs.renameSync(tmp, this.storePath);
    this.cached = store;
  }
}
