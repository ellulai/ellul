// SPDX-License-Identifier: MIT

// Module-level event bus for session status transitions.

export interface SessionStatusSignal {
  alive: boolean;
  reason?: string;
  tier?: string;
  effectiveExpiresAt?: number | null;
  sessionExpiresAt?: number | null;
  absoluteExpiry?: number | null;
  idleDeadline?: number | null;
}

type Listener = (signal: SessionStatusSignal) => void;

const listeners = new Set<Listener>();

export function onSessionStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitSessionStatus(signal: SessionStatusSignal): void {
  for (const listener of listeners) {
    try {
      listener(signal);
    } catch (e) {
      console.error("[session-events] Listener threw:", e);
    }
  }
}
