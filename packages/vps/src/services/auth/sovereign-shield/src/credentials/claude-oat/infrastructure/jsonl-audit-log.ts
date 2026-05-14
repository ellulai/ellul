// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Hash-chained JSONL audit log.
 *
 * Each entry includes prevHash + hash, where
 *   hash = SHA-256(prevHash || JSON(entry-without-hash)).
 * Tampering with any entry breaks the chain, detectable by replay.
 *
 * Resume() recovers the chain head from disk on startup so the in-memory
 * sequence and prevHash state survive restarts.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import type { AuditLog } from "../application/ports";
import type {
  AuditEntryDraft,
  ClaudeOatAuditEntry,
} from "../domain/audit";

const AUDIT_MODE = 0o640;
const VIRGIN_HASH = "0".repeat(64);

export class JsonlAuditLog implements AuditLog {
  private seq = 0;
  private prevHash = VIRGIN_HASH;

  constructor(
    private readonly auditPath: string,
    private readonly dataDir: string,
    private readonly nowIso: () => string,
  ) {}

  resume(): { lastSeq: number; lastHash: string } {
    try {
      const raw = fs.readFileSync(this.auditPath, "utf8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      if (lines.length === 0) {
        return { lastSeq: 0, lastHash: VIRGIN_HASH };
      }
      const last = JSON.parse(lines[lines.length - 1]!) as ClaudeOatAuditEntry;
      this.seq = last.seq;
      this.prevHash = last.hash;
      return { lastSeq: last.seq, lastHash: last.hash };
    } catch {
      this.seq = 0;
      this.prevHash = VIRGIN_HASH;
      return { lastSeq: 0, lastHash: VIRGIN_HASH };
    }
  }

  append(draft: AuditEntryDraft): ClaudeOatAuditEntry {
    const seq = ++this.seq;
    const ts = this.nowIso();
    const prevHash = this.prevHash;
    const entryWithoutHash = {
      seq,
      ts,
      type: draft.type,
      actor: draft.actor,
      details: draft.details,
      prevHash,
    };
    const hash = crypto
      .createHash("sha256")
      .update(prevHash)
      .update(JSON.stringify(entryWithoutHash))
      .digest("hex");
    const entry: ClaudeOatAuditEntry = { ...entryWithoutHash, hash };
    this.prevHash = hash;
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.appendFileSync(this.auditPath, JSON.stringify(entry) + "\n", {
      mode: AUDIT_MODE,
    });
    return entry;
  }
}
