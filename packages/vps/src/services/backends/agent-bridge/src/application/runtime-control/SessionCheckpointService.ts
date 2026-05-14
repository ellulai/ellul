// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import * as fs from "node:fs";
import * as path from "node:path";

export type CheckpointAdapter = "claude" | "opencode" | "cursor" | "codex";

export interface AdapterCheckpoint {
  adapter: CheckpointAdapter;
  sessionId: string;
  turn: number;
  payload: unknown;
  createdAt: number;
}

export interface CheckpointMeta {
  adapter: CheckpointAdapter;
  sandboxId: string | null;
  lastTurn: number;
  vaultVersion: number;
  updatedAt: number;
}

export interface CheckpointEntry {
  threadId: string;
  adapter: CheckpointAdapter;
  turn: number;
  updatedAt: number;
}

export interface SessionCheckpointService {
  checkpoint(threadId: string, adapter: CheckpointAdapter, payload: unknown, sessionId: string, turn: number, sandboxId?: string): Promise<void>;
  load(threadId: string): Promise<AdapterCheckpoint | null>;
  forget(threadId: string): Promise<void>;
  list(): Promise<ReadonlyArray<CheckpointEntry>>;
}

export interface CheckpointDeps {
  vaultRoot?: string;
  fs?: typeof fs;
  now?: () => number;
  emit?: (event: { event: string; threadId?: string; adapter?: string; reason?: string }) => void;
  maxTurnCheckpoints?: number;
}

const VAULT_VERSION = 1;
const DEFAULT_VAULT = "/etc/ellul/agent-bridge/sessions";
const REDACTED = "[redacted]";

const REDACT_KEY_RE = /(api[_-]?key|token|secret|oat|password|cookie|authorization|bearer|credential)/i;
const REDACT_VALUE_RES: RegExp[] = [
  /sk-ant-oat01-[A-Za-z0-9_-]{16,}/g,
  /sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{16,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /xoxb-[A-Za-z0-9-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
];

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    let out = value;
    for (const re of REDACT_VALUE_RES) out = out.replace(re, REDACTED);
    return out;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v));
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACT_KEY_RE.test(k)) o[k] = REDACTED;
    else o[k] = redact(v);
  }
  return o;
}

const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function makeSessionCheckpointService(deps: CheckpointDeps = {}): SessionCheckpointService {
  const fsImpl = deps.fs ?? fs;
  const now = deps.now ?? Date.now;
  const emit = deps.emit ?? (() => {});
  const maxTurns = deps.maxTurnCheckpoints ?? 16;
  const root = deps.vaultRoot ?? DEFAULT_VAULT;

  ensureDir(fsImpl, root);

  const inflight = new Map<string, Promise<void>>();

  async function checkpoint(
    threadId: string,
    adapter: CheckpointAdapter,
    payload: unknown,
    sessionId: string,
    turn: number,
    sandboxId?: string,
  ): Promise<void> {
    if (!THREAD_ID_RE.test(threadId)) throw new Error(`invalid threadId ${threadId}`);
    if (!Number.isInteger(turn) || turn < 0) throw new Error(`invalid turn ${turn}`);
    const prev = inflight.get(threadId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      const dir = path.join(root, threadId);
      ensureDir(fsImpl, dir);
      const cp: AdapterCheckpoint = { adapter, sessionId, turn, payload: redact(payload), createdAt: now() };
      const file = path.join(dir, `${turn}.json`);
      const tmp = `${file}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify(cp), { mode: 0o640 });
      fsImpl.renameSync(tmp, file);
      const meta: CheckpointMeta = {
        adapter,
        sandboxId: sandboxId ?? null,
        lastTurn: turn,
        vaultVersion: VAULT_VERSION,
        updatedAt: now(),
      };
      fsImpl.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta), { mode: 0o640 });
      gcOldTurns(fsImpl, dir, maxTurns);
      emit({ event: "checkpoint.write", threadId, adapter });
    });
    inflight.set(threadId, next);
    return next;
  }

  async function load(threadId: string): Promise<AdapterCheckpoint | null> {
    if (!THREAD_ID_RE.test(threadId)) throw new Error(`invalid threadId ${threadId}`);
    const dir = path.join(root, threadId);
    let entries: string[];
    try { entries = fsImpl.readdirSync(dir); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const turns = entries
      .filter((e) => /^[0-9]+\.json$/.test(e))
      .map((e) => parseInt(e.replace(".json", ""), 10))
      .sort((a, b) => b - a);
    if (turns.length === 0) return null;
    const latest = turns[0]!;
    const cp = JSON.parse(fsImpl.readFileSync(path.join(dir, `${latest}.json`), "utf8")) as AdapterCheckpoint;
    if (!cp.sessionId || cp.sessionId === REDACTED) {
      throw new Error(`checkpoint ${threadId}/${latest} sessionId is missing or redacted`);
    }
    return cp;
  }

  async function forget(threadId: string): Promise<void> {
    if (!THREAD_ID_RE.test(threadId)) throw new Error(`invalid threadId ${threadId}`);
    const dir = path.join(root, threadId);
    fsImpl.rmSync(dir, { recursive: true, force: true });
    inflight.delete(threadId);
  }

  async function list(): Promise<ReadonlyArray<CheckpointEntry>> {
    const dirs = fsImpl.readdirSync(root);
    return dirs.map((d) => {
      const meta = JSON.parse(fsImpl.readFileSync(path.join(root, d, "meta.json"), "utf8")) as CheckpointMeta;
      return { threadId: d, adapter: meta.adapter, turn: meta.lastTurn, updatedAt: meta.updatedAt };
    });
  }

  return { checkpoint, load, forget, list };
}

function ensureDir(fsImpl: typeof fs, dir: string): void {
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o750 });
}

function gcOldTurns(fsImpl: typeof fs, dir: string, keep: number): void {
  const entries = fsImpl.readdirSync(dir);
  const turns = entries
    .filter((e) => /^[0-9]+\.json$/.test(e))
    .map((e) => parseInt(e.replace(".json", ""), 10))
    .sort((a, b) => b - a);
  for (const t of turns.slice(keep)) {
    fsImpl.unlinkSync(path.join(dir, `${t}.json`));
  }
  for (const e of entries) if (e.endsWith(".tmp")) fsImpl.unlinkSync(path.join(dir, e));
}
