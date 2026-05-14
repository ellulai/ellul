// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

export interface ThreadRow {
  threadId: string;
  sandboxId: string;
  archivedAt: number | null;
  updatedAt: number;
}

export interface ThreadStore {
  listForSandbox(sandboxId: string): Promise<ReadonlyArray<ThreadRow>>;
  setArchivedAt(threadId: string, at: number | null): Promise<void>;
}

export interface ThreadArchiveDeps {
  store: ThreadStore;
  now?: () => number;
  emit?: (event: { event: string; threadId: string; sandboxId: string; archivedAt?: number | null }) => void;
}

export interface ThreadArchiveService {
  sweep(sandboxId: string, cap: number): Promise<ReadonlyArray<string>>;
  unarchive(threadId: string, sandboxId: string): Promise<void>;
  listForSandbox(sandboxId: string): Promise<ReadonlyArray<ThreadRow>>;
}

export function makeThreadArchive(deps: ThreadArchiveDeps): ThreadArchiveService {
  const now = deps.now ?? Date.now;
  const emit = deps.emit ?? (() => {});

  return {
    async sweep(sandboxId, cap) {
      if (cap < 0) throw new Error("cap must be >= 0");
      const rows = await deps.store.listForSandbox(sandboxId);
      const active = rows.filter((r) => r.archivedAt === null).sort((a, b) => b.updatedAt - a.updatedAt);
      const overflow = active.slice(cap);
      const at = now();
      const archived: string[] = [];
      for (const row of overflow) {
        await deps.store.setArchivedAt(row.threadId, at);
        emit({ event: "thread.archived", threadId: row.threadId, sandboxId, archivedAt: at });
        archived.push(row.threadId);
      }
      return archived;
    },
    async unarchive(threadId, sandboxId) {
      await deps.store.setArchivedAt(threadId, null);
      emit({ event: "thread.unarchived", threadId, sandboxId, archivedAt: null });
    },
    listForSandbox(sandboxId) { return deps.store.listForSandbox(sandboxId); },
  };
}
