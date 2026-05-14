// SPDX-License-Identifier: MIT
"use client";

import { useMemo } from "react";
import { useVpsBridge } from "@/lib/vps-bridge";
import type { DbApi, QueryResult, DbEntry, BackupEntry, SchemaResponse } from "./database-types";

export function useDirectDbApi(vpsUrl: string): DbApi {
  return useMemo(() => ({
    checkStatus: async () => {
      const res = await fetch(`${vpsUrl}/_auth/db/status`, { credentials: "include", headers: { Accept: "application/json" } });
      if (!res.ok) return { available: false };
      return res.json();
    },
    executeSql: async (sandboxId, sql, database) => {
      const res = await fetch(`${vpsUrl}/_auth/db/execute`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sandboxId, sql, database }) });
      if (!res.ok) { const err = await res.json().catch(() => ({ error: "Failed" })); throw new Error(err.error || "Query failed"); }
      return res.json();
    },
    executeReadSql: async (sandboxId, sql, database) => {
      const res = await fetch(`${vpsUrl}/_auth/db/query`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sandboxId, sql, database }) });
      if (!res.ok) { const err = await res.json().catch(() => ({ error: "Failed" })); throw new Error(err.error || "Query failed"); }
      return res.json();
    },
    listDatabases: async (sandboxId) => {
      const res = await fetch(`${vpsUrl}/_auth/db/list?sandboxId=${encodeURIComponent(sandboxId)}`, { credentials: "include", headers: { Accept: "application/json" } });
      if (!res.ok) { const err = await res.json().catch(() => ({ error: "Failed" })); throw new Error(err.error || "Failed to list databases"); }
      const data = await res.json();
      return data.databases ?? [];
    },
    getSchema: async (sandboxId, database) => {
      const res = await fetch(`${vpsUrl}/_auth/db/schema?sandboxId=${encodeURIComponent(sandboxId)}&database=${encodeURIComponent(database)}`, { credentials: "include", headers: { Accept: "application/json" } });
      if (!res.ok) { const err = await res.json().catch(() => ({ error: "Failed" })); throw new Error(err.error || "Failed to load schema"); }
      return res.json();
    },
    createDb: async (sandboxId, label) => {
      const res = await fetch(`${vpsUrl}/_auth/db/create`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sandboxId, label }) });
      if (!res.ok) { const err = await res.json().catch(() => ({ error: "Failed" })); throw new Error(err.error || "Failed to create database"); }
      return res.json();
    },
    dropDb: async (sandboxId, label) => {
      const res = await fetch(`${vpsUrl}/_auth/db/drop`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sandboxId, label }) });
      if (!res.ok) { const err = await res.json().catch(() => ({ error: "Failed" })); throw new Error(err.error || "Failed to drop database"); }
      return res.json();
    },
    assignDb: async (sandboxId, label, role) => {
      const res = await fetch(`${vpsUrl}/_auth/db/assign`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sandboxId, label, role }) });
      if (!res.ok) { const err = await res.json().catch(() => ({ error: "Failed" })); throw new Error(err.error || "Failed to assign database"); }
      return res.json();
    },
    listBackups: async (sandboxId) => {
      const res = await fetch(`${vpsUrl}/_auth/db/backups?sandboxId=${encodeURIComponent(sandboxId)}`, { credentials: "include", headers: { Accept: "application/json" } });
      if (!res.ok) { const err = await res.json().catch(() => ({ error: "Failed" })); throw new Error(err.error || "Failed to list backups"); }
      const data = await res.json();
      return data.backups ?? [];
    },
    createBackup: async (sandboxId) => {
      const res = await fetch(`${vpsUrl}/_auth/db/backup`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sandboxId }) });
      if (!res.ok) { const err = await res.json().catch(() => ({ error: "Failed" })); throw new Error(err.error || "Backup failed"); }
      return res.json();
    },
    restoreBackup: async (sandboxId, file) => {
      const res = await fetch(`${vpsUrl}/_auth/db/restore`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sandboxId, file }) });
      if (!res.ok) { const err = await res.json().catch(() => ({ error: "Failed" })); throw new Error(err.error || "Restore failed"); }
      return res.json();
    },
  }), [vpsUrl]);
}

export function useBridgeDbApi(): DbApi {
  const { send } = useVpsBridge();
  return useMemo(() => ({
    checkStatus: () => send<{ available: boolean }>("db_status", {}),
    executeSql: (sandboxId, sql, database) => send<QueryResult>("db_execute", { sandboxId, sql, database }),
    executeReadSql: (sandboxId, sql, database) => send<QueryResult>("db_query", { sandboxId, sql, database }),
    listDatabases: async (sandboxId) => { const data = await send<{ databases: DbEntry[] }>("db_list", { sandboxId }); return data.databases ?? []; },
    getSchema: (sandboxId, database) => send<SchemaResponse>("db_schema", { sandboxId, database }),
    createDb: (sandboxId, label) => send("db_create", { sandboxId, label }),
    dropDb: (sandboxId, label) => send("db_drop", { sandboxId, label }),
    assignDb: (sandboxId, label, role) => send("db_assign", { sandboxId, label, role }),
    listBackups: async (sandboxId) => { const data = await send<{ backups: BackupEntry[] }>("db_backups", { sandboxId }); return data.backups ?? []; },
    createBackup: (sandboxId) => send<{ success: boolean; file: string }>("db_backup", { sandboxId }),
    restoreBackup: (sandboxId, file) => send("db_restore", { sandboxId, file }),
  }), [send]);
}
