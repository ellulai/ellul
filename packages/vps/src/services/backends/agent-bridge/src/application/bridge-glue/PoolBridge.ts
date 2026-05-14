// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import {
  listCursorAcpPoolEntries,
  listOpenCodePoolEntries,
  listZeroClawPoolEntries,
  sweepCursorIdleAgents,
  sweepOpenCodeIdleServers,
  sweepZeroClawIdleDaemons,
} from "../../adapters/runtime";
import type { CompactableAdapter } from "../runtime-control/SessionCompactor";
import type { PoolManagerSlim } from "../../composition/runtime-control/RuntimeControlLayer";

export function makeBridgePoolManager(): PoolManagerSlim {
  return {
    async evictColdScopes(reason) {
      void reason;
      try { await sweepOpenCodeIdleServers(0); } catch { /* opportunistic */ }
      try { await sweepCursorIdleAgents(0); } catch { /* opportunistic */ }
      try { await sweepZeroClawIdleDaemons(0); } catch { /* opportunistic */ }
    },
    async flushIdle(reason) {
      void reason;
      try { await sweepOpenCodeIdleServers(0); } catch { /* opportunistic */ }
      try { await sweepCursorIdleAgents(0); } catch { /* opportunistic */ }
      try { await sweepZeroClawIdleDaemons(0); } catch { /* opportunistic */ }
    },
    compactableAdapters(): ReadonlyArray<CompactableAdapter> {
      return [
        makeCompactable("opencode", listOpenCodePoolEntries, sweepOpenCodeIdleServers),
        makeCompactable("cursor", listCursorAcpPoolEntries, sweepCursorIdleAgents),
        makeCompactable("codex", listZeroClawPoolEntries, sweepZeroClawIdleDaemons),
      ];
    },
  };
}

interface PoolEntry { project: string; sessionCount: number; refCount: number; idleSince: number | null }

function makeCompactable(
  adapter: CompactableAdapter["adapter"],
  list: () => Promise<ReadonlyArray<PoolEntry>>,
  sweep: (maxIdleMs: number) => Promise<{ evicted: number; retained: number }>,
): CompactableAdapter {
  return {
    adapter,
    async listSessions() {
      try {
        const entries = await list();
        return entries.map((e) => ({ sessionId: e.project, turnCount: e.sessionCount, sandbox: e.project }));
      } catch { return []; }
    },
    async compactSession(_sessionId, _keepLastN) {
      try {
        const r = await sweep(0);
        return { droppedTurns: r.evicted, freedBytesEst: r.evicted * 240 * 1024 * 1024 };
      } catch { return { droppedTurns: 0, freedBytesEst: 0 }; }
    },
  };
}
