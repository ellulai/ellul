// TEMPORARY DEBUG OVERLAY — remove after fixing WS issue
"use client";

import { useCodeToken } from "@/contexts/CodeTokenContext";
import { useRealtime } from "@/providers/realtime-provider";
import { useVpsBridge } from "@/lib/vps-bridge";
import { useState, useEffect, useRef } from "react";

export function DebugOverlay() {
  const { token, loading, error, codeSessionId, sessionExpiresAt } = useCodeToken();
  const { status, isConnected } = useRealtime();
  const bridge = useVpsBridge();
  const bridgeReady = bridge.ready;
  const needsVpsAuth = bridge.needsVpsAuth;
  const [logs, setLogs] = useState<string[]>([]);
  const logsRef = useRef(logs);
  logsRef.current = logs;

  useEffect(() => {
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;

    const capture = (level: string) => (...args: unknown[]) => {
      const msg = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
      if (msg.includes("[ellul-debug]")) {
        setLogs(prev => [...prev.slice(-30), `[${level}] ${msg}`]);
      }
    };

    console.log = (...args: unknown[]) => { capture("log")(...args); origLog(...args); };
    console.error = (...args: unknown[]) => { capture("err")(...args); origError(...args); };
    console.warn = (...args: unknown[]) => { capture("wrn")(...args); origWarn(...args); };

    return () => {
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
    };
  }, []);

  return (
    <div style={{
      position: "fixed",
      bottom: 0,
      left: 0,
      right: 0,
      maxHeight: "40vh",
      overflow: "auto",
      background: "rgba(0,0,0,0.95)",
      color: "#0f0",
      fontFamily: "monospace",
      fontSize: "11px",
      padding: "8px",
      zIndex: 99999,
      borderTop: "2px solid #333",
    }}>
      <div style={{ marginBottom: "4px", color: "#ff0" }}>
        <b>CodeToken:</b> token={token ?? "null"} | loading={String(loading)} | error={error ?? "null"} | sessionId={codeSessionId?.slice(0, 8) ?? "null"} | expires={sessionExpiresAt ? new Date(sessionExpiresAt).toLocaleTimeString() : "0"}
      </div>
      <div style={{ marginBottom: "4px", color: "#0ff" }}>
        <b>Realtime:</b> status={status} | connected={String(isConnected)}
      </div>
      <div style={{ marginBottom: "4px", color: "#f0f" }}>
        <b>Bridge:</b> ready={String(bridgeReady)} | needsVpsAuth={String(needsVpsAuth ?? "undefined")}
      </div>
      <div style={{ borderTop: "1px solid #333", paddingTop: "4px" }}>
        {logs.map((l, i) => (
          <div key={i} style={{ color: l.includes("err") ? "#f66" : l.includes("wrn") ? "#ff6" : "#0f0" }}>{l}</div>
        ))}
        {logs.length === 0 && <div style={{ color: "#666" }}>Waiting for [ellul-debug] logs...</div>}
      </div>
    </div>
  );
}
