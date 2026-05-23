// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { useState, useEffect, useRef, useCallback } from "react";
import { getCodeWsUrl } from "@shared/security";
import type { FileNode, GitChange } from "../types";

interface WebSocketState {
  connected: boolean;
  tree: FileNode | null;
  changes: GitChange[];
  treeVersion: number;
  // Signals that the project list changed (new repo cloned, folder removed, etc.)
  projectsChanged: number;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_GRACE_MS = 3000;

// Same-origin WebSocket to file-api /ws.
export function useWebSocket(project: string | null) {
  const [state, setState] = useState<WebSocketState>({
    connected: false,
    tree: null,
    changes: [],
    treeVersion: 0,
    projectsChanged: 0,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalCloseRef = useRef(false);
  const connectIdRef = useRef(0);

  const connect = useCallback(() => {
    if (!project) return;

    const thisConnectId = ++connectIdRef.current;

    const ws = new WebSocket(getCodeWsUrl());
    wsRef.current = ws;
    intentionalCloseRef.current = false;

    ws.onopen = () => {
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      setState((s) => ({ ...s, connected: true }));
      reconnectRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case "tree":
            if (msg.data?.project === project) {
              setState((s) => ({
                ...s,
                tree: msg.data.tree,
                treeVersion: s.treeVersion + 1,
              }));
            }
            break;

          case "status":
            if (msg.data?.project === project) {
              setState((s) => ({
                ...s,
                changes: msg.data.modified || [],
              }));
            }
            break;

          case "apps_changed":
            setState((s) => ({
              ...s,
              projectsChanged: s.projectsChanged + 1,
            }));
            break;

          case "connected":
            break;
        }
      } catch {
        // Ignore malformed
      }
    };

    ws.onclose = () => {
      // Ignore onclose from superseded connections
      if (thisConnectId !== connectIdRef.current) return;
      if (intentionalCloseRef.current) return;

      if (reconnectRef.current < MAX_RECONNECT_ATTEMPTS) {
        // Grace period — only show disconnected after 3s
        if (!graceTimerRef.current) {
          graceTimerRef.current = setTimeout(() => {
            graceTimerRef.current = null;
            setState((s) => ({ ...s, connected: false }));
          }, RECONNECT_GRACE_MS);
        }
        reconnectRef.current++;
        const delay = Math.min(1000 * Math.pow(2, reconnectRef.current - 1), 16000);
        reconnectTimerRef.current = setTimeout(connect, delay);
      } else {
        // All attempts exhausted
        if (graceTimerRef.current) {
          clearTimeout(graceTimerRef.current);
          graceTimerRef.current = null;
        }
        setState((s) => ({ ...s, connected: false }));
      }
    };

    ws.onerror = () => {
      // onerror is always followed by onclose — reconnection logic lives there
      ws.close();
    };
  }, [project]);

  useEffect(() => {
    connect();
    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return state;
}
