# 13 — ThreadArchive

> Status: shipped (`apps/api/src/services/thread-archive.service.ts` + tests + sweep route).

## What this layer owns

Soft-archive of per-sandbox threads beyond the tier-visible cap (`sidebarVisibleThreadsCap`: 30 on $20, 100 on $50). Archived = visibility filter only; data preserved; pro Claude slots in archived threads torn down.

## Algorithm

For each sandbox with threads:

1. List active (non-archived) threads ordered by `updatedAt` desc.
2. If count ≤ cap: nothing to do.
3. For each thread beyond the first `cap`: set `archivedAt = now()` and emit `thread.archived` event for the bridge to broadcast.
4. For archived threads, ask `ProClaudeSlotManager` to release any bound slot (decoupled — the manager listens for `thread.archived`).

## API

```ts
export interface ThreadArchiveService {
  /** Archive threads beyond cap; returns archived thread ids. */
  sweep(sandboxId: string, cap: number): Promise<ReadonlyArray<string>>;
  unarchive(threadId: string): Promise<void>;
  /** All threads regardless of archive state, plus archive flag. */
  listForSandbox(sandboxId: string): Promise<ReadonlyArray<{ threadId: string; archivedAt: number | null; updatedAt: number }>>;
}
```

## Sweep cadence

Runs per-sandbox on:

- Thread create (post-create check).
- Thread updated (post-update check; cheap — only re-evaluates one sandbox).
- Daily background sweep over every sandbox (covers cases where activity stops without an explicit update — e.g. user closes tab).

## Unarchive UX

Click on an archived thread in the sidebar → unarchive (clears `archivedAt`) → bridge state machine `unarchive` event fires (returns to `cold`). Re-warming on next send.

## DB schema

Add `archived_at TIMESTAMPTZ NULL` column to existing `threads` table. Index on `(sandbox_id, archived_at, updated_at DESC)` for efficient cap-from-active query.

Migration: backfill `archived_at = NULL` for all existing rows.

## Acceptance

| Criterion | Verified by |
|---|---|
| Archives the (count − cap) least-recent threads | Unit test |
| Returns archived thread ids | Unit test |
| Idempotent: re-running sweep with no changes archives nothing | Unit test |
| `unarchive(threadId)` clears `archivedAt` | Unit test |
| Pro Claude slot manager released on archive (via event listener) | Integration test |
