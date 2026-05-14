// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Session-id → open WebSocket connections. Populated by the ws-rpc server
// on handshake, read by /api/internal/session-revoked to close connections
// when shield rotates/revokes a session. Module-level singleton — there is
// exactly one registry per process.

import type * as WsLib from "ws";

const connections = new Map<string, Set<WsLib.WebSocket>>();

export function registerSessionConnection(sessionId: string, ws: WsLib.WebSocket): void {
  let set = connections.get(sessionId);
  if (!set) {
    set = new Set();
    connections.set(sessionId, set);
  }
  set.add(ws);
}

export function unregisterSessionConnection(sessionId: string, ws: WsLib.WebSocket): void {
  const set = connections.get(sessionId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connections.delete(sessionId);
}

export function closeSessionConnections(
  sessionId: string,
  code: number,
  reason: string,
): number {
  const set = connections.get(sessionId);
  if (!set) return 0;
  let closed = 0;
  for (const ws of set) {
    try {
      ws.close(code, reason);
      closed++;
    } catch {}
  }
  return closed;
}

export function closeAllSessionConnections(code: number, reason: string): number {
  let closed = 0;
  for (const [, set] of connections) {
    for (const ws of set) {
      try {
        ws.close(code, reason);
        closed++;
      } catch {}
    }
  }
  return closed;
}

export function broadcastToAllSessions(payload: unknown): number {
  const text = JSON.stringify(payload);
  let sent = 0;
  for (const [, set] of connections) {
    for (const ws of set) {
      try {
        if ((ws as { readyState?: number }).readyState === 1) {
          ws.send(text);
          sent++;
        }
      } catch {}
    }
  }
  return sent;
}
