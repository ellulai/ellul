// SPDX-License-Identifier: MIT

// ── Shared types for database browser components ──

export interface DatabaseBrowserProps {
  serverDomain: string;
  sandboxId: string;
  tier?: "standard" | "web_locked" | "private_locked";
  // External tab control (from mobile bottom nav). Internal state used if omitted.
  activeTab?: DbTab;
}

export type DbTab = "tables" | "sql" | "bin" | "settings";

export interface BackupEntry {
  file: string;
  sizeBytes: number;
}

export interface DbApi {
  checkStatus: () => Promise<{ available: boolean }>;
  executeSql: (sandboxId: string, sql: string, database?: string) => Promise<QueryResult>;
  executeReadSql: (sandboxId: string, sql: string, database?: string) => Promise<QueryResult>;
  listDatabases: (sandboxId: string) => Promise<DbEntry[]>;
  getSchema: (sandboxId: string, database: string) => Promise<SchemaResponse>;
  createDb: (sandboxId: string, label: string) => Promise<unknown>;
  dropDb: (sandboxId: string, label: string) => Promise<unknown>;
  assignDb: (sandboxId: string, label: string | null, role: string) => Promise<unknown>;
  listBackups: (sandboxId: string) => Promise<BackupEntry[]>;
  createBackup: (sandboxId: string) => Promise<{ success: boolean; file: string }>;
  restoreBackup: (sandboxId: string, file: string) => Promise<unknown>;
}

export interface DbEntry {
  label: string;
  dbName: string;
  sizeBytes: number;
  createdAt: number;
  isPreview: boolean;
  isDeployed: boolean;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  rowCount: number;
}

export interface SchemaResponse {
  tables: TableInfo[];
}

export interface QueryResult {
  rows: Record<string, string>[];
  rowCount: number;
  command: string;
  category?: string;
}

// ── Column filter types ──

export type FilterOp = "eq" | "neq" | "contains" | "not_contains" | "is_null" | "is_not_null" | "gt" | "lt" | "gte" | "lte";

export interface ColumnFilter {
  op: FilterOp;
  value: string;
}

export const FILTER_OPS: { value: FilterOp; label: string; needsValue: boolean }[] = [
  { value: "eq", label: "equals", needsValue: true },
  { value: "neq", label: "not equals", needsValue: true },
  { value: "contains", label: "contains", needsValue: true },
  { value: "not_contains", label: "not contains", needsValue: true },
  { value: "gt", label: ">", needsValue: true },
  { value: "gte", label: ">=", needsValue: true },
  { value: "lt", label: "<", needsValue: true },
  { value: "lte", label: "<=", needsValue: true },
  { value: "is_null", label: "is null", needsValue: false },
  { value: "is_not_null", label: "is not null", needsValue: false },
];

export const PG_TYPES = [
  "text", "varchar(255)", "integer", "bigint", "smallint", "serial", "bigserial",
  "boolean", "uuid", "timestamp", "timestamptz", "date", "time",
  "numeric", "float8", "jsonb", "json", "bytea",
];

export const PAGE_SIZE = 50;
export const TRASH_PAGE_SIZE = 50;

// ── Helpers ──

export function escSql(v: string): string {
  return v.replace(/'/g, "''");
}

export function buildWhereClause(filters: Record<string, ColumnFilter>): string {
  const parts: string[] = [];
  for (const [col, f] of Object.entries(filters)) {
    const c = `"${col}"`;
    const v = `'${escSql(f.value)}'`;
    switch (f.op) {
      case "eq": parts.push(`${c} = ${v}`); break;
      case "neq": parts.push(`${c} != ${v}`); break;
      case "contains": parts.push(`${c}::text ILIKE '%${escSql(f.value)}%'`); break;
      case "not_contains": parts.push(`${c}::text NOT ILIKE '%${escSql(f.value)}%'`); break;
      case "gt": parts.push(`${c} > ${v}`); break;
      case "gte": parts.push(`${c} >= ${v}`); break;
      case "lt": parts.push(`${c} < ${v}`); break;
      case "lte": parts.push(`${c} <= ${v}`); break;
      case "is_null": parts.push(`${c} IS NULL`); break;
      case "is_not_null": parts.push(`${c} IS NOT NULL`); break;
    }
  }
  return parts.join(" AND ");
}

export function isDestructiveSql(sql: string): boolean {
  const upper = sql.toUpperCase().replace(/\s+/g, " ").trim();
  return /^(DROP |DELETE |TRUNCATE |ALTER\s+TABLE\s+\S+\s+DROP )/.test(upper);
}

import { Hash, Type, Calendar, ToggleLeft } from "lucide-react";

export function getTypeIcon(type: string) {
  const t = type.toLowerCase();
  if (t.includes("int") || t.includes("numeric") || t.includes("float") || t.includes("double") || t.includes("decimal") || t.includes("serial")) return Hash;
  if (t.includes("char") || t.includes("text") || t.includes("uuid") || t.includes("json")) return Type;
  if (t.includes("timestamp") || t.includes("date") || t.includes("time")) return Calendar;
  if (t.includes("bool")) return ToggleLeft;
  return Type;
}

export function formatType(type: string): string {
  const map: Record<string, string> = {
    "character varying": "varchar", "timestamp without time zone": "timestamp",
    "timestamp with time zone": "timestamptz", "double precision": "float8",
    "boolean": "bool", "integer": "int4", "bigint": "int8", "smallint": "int2",
  };
  return map[type] || type;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
