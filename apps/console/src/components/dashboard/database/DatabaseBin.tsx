// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Table2,
  Trash2,
  X,
  Search,
  ArrowUp,
  ArrowDown,
  RefreshCw,
  ShieldCheck,
  Undo2,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type {
  DbApi,
  DbEntry,
  SchemaResponse,
  QueryResult,
  ColumnInfo,
} from "./database-types";
import { escSql, TRASH_PAGE_SIZE } from "./database-types";
import { RecoverDialog, PurgeDialog } from "./DatabaseBinDialogs";
import { DatabaseBinContent } from "./DatabaseBinContent";

interface DatabaseBinProps {
  serverDomain: string;
  sandboxId: string;
  api: DbApi;
  selectedDb: DbEntry | null;
  schema: SchemaResponse | undefined;
  onRefreshData: () => void;
}

export function DatabaseBin({
  serverDomain,
  sandboxId,
  api,
  selectedDb,
  schema,
  onRefreshData,
}: DatabaseBinProps) {
  const t = useTranslations("console.database.bin");
  // ── State ──
  const [trashTable, setTrashTable] = useState<string | null>(null);
  const [trashPage, setTrashPage] = useState(0);
  const [trashSelected, setTrashSelected] = useState<Set<string>>(new Set());
  const [showRecoverConfirm, setShowRecoverConfirm] = useState(false);
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [purgeAllMode, setPurgeAllMode] = useState(false);
  const [purgeConfirmText, setPurgeConfirmText] = useState("");
  const [trashSearch, setTrashSearch] = useState("");
  const [trashSortDir, setTrashSortDir] = useState<"DESC" | "ASC">("DESC");

  // ── API helpers ──

  const executeSql = async (sql: string): Promise<QueryResult> => {
    return api.executeSql(sandboxId, sql, selectedDb?.dbName);
  };

  const executeReadSql = async (sql: string): Promise<QueryResult> => {
    return api.executeReadSql(sandboxId, sql, selectedDb?.dbName);
  };

  // ── Trash: discover tables with deleted_at column ──

  const { data: trashTables, isLoading: isLoadingTrashTables, refetch: refetchTrashTables } = useQuery<Array<{ table_name: string; deleted_count: number }>>({
    queryKey: ["db-trash-tables", serverDomain, sandboxId, selectedDb?.dbName],
    queryFn: async () => {
      const discovery = await executeReadSql(
        `SELECT c.table_name FROM information_schema.columns c WHERE c.column_name = 'deleted_at' AND c.table_schema = 'public' ORDER BY c.table_name`
      );
      if (!discovery.rows.length) return [];
      const unions = discovery.rows.map((row) => {
        const tbl = escSql(row.table_name!);
        return `SELECT '${tbl}' AS table_name, COUNT(*) AS cnt FROM "${row.table_name!}" WHERE deleted_at IS NOT NULL`;
      }).join(" UNION ALL ");
      const counts = await executeReadSql(unions);
      return counts.rows.map((r) => ({
        table_name: r.table_name!,
        deleted_count: parseInt(r.cnt ?? "0", 10),
      }));
    },
    enabled: !!selectedDb,
    staleTime: 15_000,
  });

  // Detect primary key columns for the selected trash table
  const { data: trashPkColumns } = useQuery<string[]>({
    queryKey: ["db-trash-pk", serverDomain, sandboxId, selectedDb?.dbName, trashTable],
    queryFn: async () => {
      const result = await executeReadSql(
        `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = '"${escSql(trashTable!)}"'::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`
      );
      return result.rows.map((r) => r.attname!);
    },
    enabled: !!selectedDb && !!trashTable,
    staleTime: 60_000,
  });

  // Get column info for the trash table from schema
  const trashTableColumns = useMemo(() => {
    if (!trashTable || !schema?.tables) return [];
    return schema.tables.find((tbl) => tbl.name === trashTable)?.columns ?? [];
  }, [trashTable, schema]);

  // Build WHERE for trash search
  const trashSearchWhere = useMemo(() => {
    if (!trashSearch.trim() || !trashTableColumns.length) return "";
    const term = escSql(trashSearch.trim());
    const conditions = trashTableColumns
      .filter((c) => c.name !== "deleted_at" && c.name !== "deleted_by")
      .map((c) => `"${c.name}"::text ILIKE '%${term}%'`);
    return conditions.length > 0 ? ` AND (${conditions.join(" OR ")})` : "";
  }, [trashSearch, trashTableColumns]);

  const { data: trashData, isLoading: isLoadingTrashData, isFetching: isFetchingTrashData, refetch: refetchTrashData } = useQuery<QueryResult>({
    queryKey: ["db-trash-data", serverDomain, sandboxId, selectedDb?.dbName, trashTable, trashPage, trashSortDir, trashSearch],
    queryFn: () => executeReadSql(
      `SELECT * FROM "${trashTable}" WHERE deleted_at IS NOT NULL${trashSearchWhere} ORDER BY deleted_at ${trashSortDir} LIMIT ${TRASH_PAGE_SIZE} OFFSET ${trashPage * TRASH_PAGE_SIZE}`
    ),
    enabled: !!selectedDb && !!trashTable,
    staleTime: 10_000,
  });

  const { data: trashTotalCount } = useQuery<number>({
    queryKey: ["db-trash-count", serverDomain, sandboxId, selectedDb?.dbName, trashTable, trashSearch],
    queryFn: async () => {
      const r = await executeReadSql(`SELECT COUNT(*) AS cnt FROM "${trashTable}" WHERE deleted_at IS NOT NULL${trashSearchWhere}`);
      return parseInt(r.rows[0]?.cnt ?? "0", 10);
    },
    enabled: !!selectedDb && !!trashTable,
    staleTime: 15_000,
  });

  const trashTotalPages = Math.max(1, Math.ceil((trashTotalCount ?? 0) / TRASH_PAGE_SIZE));
  const trashRows = trashData?.rows ?? [];

  // Clear selection on page/table/search change
  useEffect(() => { setTrashSelected(new Set()); }, [trashPage, trashTable, trashSearch]);

  // Auto-select first trash table with deleted rows
  useEffect(() => {
    if (!trashTable && trashTables && trashTables.length > 0) {
      const withRows = trashTables.find((tbl) => tbl.deleted_count > 0);
      setTrashTable((withRows ?? trashTables[0])!.table_name);
    }
  }, [trashTables, trashTable]);

  // Build row condition using PK if available, fall back to all-columns
  const buildRowCondition = useCallback((row: Record<string, string>, tableColumns: ColumnInfo[], pkCols: string[]) => {
    const cols = pkCols.length > 0
      ? tableColumns.filter((c) => pkCols.includes(c.name))
      : tableColumns;
    return cols.map((col) => {
      const v = row[col.name];
      if (v === null || v === undefined) return `"${col.name}" IS NULL`;
      return `"${col.name}" = '${escSql(String(v))}'`;
    }).join(" AND ");
  }, []);

  // Stable row key
  const trashRowKey = useCallback((row: Record<string, string>) => {
    if (trashPkColumns && trashPkColumns.length > 0) {
      return trashPkColumns.map((pk) => `${pk}=${row[pk]}`).join("&");
    }
    return JSON.stringify(row);
  }, [trashPkColumns]);

  const recoverMutation = useMutation<void, Error, { table: string; rows: Record<string, string>[]; columns: ColumnInfo[]; pk: string[] }>({
    mutationFn: async ({ table, rows, columns: cols, pk }) => {
      for (const row of rows) {
        const condition = buildRowCondition(row, cols, pk);
        await executeSql(`UPDATE "${table}" SET deleted_at = NULL, deleted_by = NULL WHERE ${condition} AND deleted_at IS NOT NULL`);
      }
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.rows.length === 1 ? t("rowsRecoveredSingular", { count: vars.rows.length }) : t("rowsRecoveredPlural", { count: vars.rows.length }));
      setTrashSelected(new Set());
      setShowRecoverConfirm(false);
      refetchTrashData();
      refetchTrashTables();
      onRefreshData();
    },
    onError: (err) => toast.error(err.message),
  });

  const purgeMutation = useMutation<void, Error, { table: string; rows: Record<string, string>[]; columns: ColumnInfo[]; pk: string[] }>({
    mutationFn: async ({ table, rows, columns: cols, pk }) => {
      for (const row of rows) {
        const condition = buildRowCondition(row, cols, pk);
        await executeSql(`DELETE FROM "${table}" WHERE ${condition} AND deleted_at IS NOT NULL`);
      }
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.rows.length === 1 ? t("rowsPurgedSingular", { count: vars.rows.length }) : t("rowsPurgedPlural", { count: vars.rows.length }));
      setTrashSelected(new Set());
      setShowPurgeConfirm(false);
      setPurgeConfirmText("");
      refetchTrashData();
      refetchTrashTables();
    },
    onError: (err) => toast.error(err.message),
  });

  const purgeAllMutation = useMutation<void, Error, { table: string }>({
    mutationFn: async ({ table }) => {
      await executeSql(`DELETE FROM "${table}" WHERE deleted_at IS NOT NULL`);
    },
    onSuccess: () => {
      toast.success(t("allPurgedSuccess"));
      setTrashSelected(new Set());
      setShowPurgeConfirm(false);
      setPurgeAllMode(false);
      setPurgeConfirmText("");
      refetchTrashData();
      refetchTrashTables();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleTrashSelectAll = useCallback(() => {
    if (trashSelected.size === trashRows.length && trashRows.length > 0) {
      setTrashSelected(new Set());
    } else {
      setTrashSelected(new Set(trashRows.map(trashRowKey)));
    }
  }, [trashRows, trashSelected.size, trashRowKey]);

  const handleTrashToggleRow = useCallback((row: Record<string, string>) => {
    const key = trashRowKey(row);
    setTrashSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [trashRowKey]);

  const getSelectedTrashRows = useCallback(() => {
    return trashRows.filter((row) => trashSelected.has(trashRowKey(row)));
  }, [trashRows, trashSelected, trashRowKey]);

  const handleRecoverSingle = useCallback((row: Record<string, string>) => {
    if (!trashTable) return;
    recoverMutation.mutate({ table: trashTable, rows: [row], columns: trashTableColumns, pk: trashPkColumns ?? [] });
  }, [trashTable, trashTableColumns, trashPkColumns, recoverMutation]);

  const handlePurgeSingle = useCallback((row: Record<string, string>) => {
    if (!trashTable) return;
    purgeMutation.mutate({ table: trashTable, rows: [row], columns: trashTableColumns, pk: trashPkColumns ?? [] });
  }, [trashTable, trashTableColumns, trashPkColumns, purgeMutation]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header bar */}
      <div className="shrink-0 border-b border-border px-3 py-2 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs text-cream/60">
          <Trash2 className="h-3.5 w-3.5" />
          <span className="font-medium text-cream/75">{t("softDeletedRows")}</span>
        </div>
        <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-cream/60 hover:text-cream/85" onClick={() => { refetchTrashTables(); if (trashTable) refetchTrashData(); }}>
            <RefreshCw className={cn("h-3 w-3", isFetchingTrashData && "animate-spin")} />
          </Button>
        </TooltipTrigger><TooltipContent>{t("refresh")}</TooltipContent></Tooltip></TooltipProvider>

        {/* Audit badge */}
        <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild>
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-sodium/5 border border-sodium/15">
            <ShieldCheck className="h-2.5 w-2.5 text-sodium/60" />
            <span className="text-[9px] text-sodium/60 font-medium">{t("audited")}</span>
          </div>
        </TooltipTrigger><TooltipContent className="max-w-[240px] text-xs">{t("auditedTooltip")}</TooltipContent></Tooltip></TooltipProvider>

        <div className="flex-1" />

        {/* Search */}
        {trashTable && trashRows.length > 0 && (
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-cream/45" />
            <input
              type="text"
              value={trashSearch}
              onChange={(e) => { setTrashSearch(e.target.value); setTrashPage(0); }}
              placeholder={t("searchPlaceholder")}
              className="h-7 w-40 sm:w-52 text-[10px] bg-transparent pl-7 pr-2 border border-cream/[0.06] rounded-md text-cream/85 placeholder:text-cream/45 focus:outline-none focus:ring-1 focus:ring-sodium/50"
            />
            {trashSearch && (
              <button type="button" onClick={() => { setTrashSearch(""); setTrashPage(0); }} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-cream/45 hover:text-cream/75">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}

        {/* Bulk actions */}
        {trashTable && trashSelected.size > 0 && (
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-sodium border-sodium/30 tabular-nums">
              {t("selectionBadge", { selected: trashSelected.size, total: trashRows.length })}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[10px] px-2 text-sodium hover:text-sodium hover:bg-sodium/10"
              disabled={recoverMutation.isPending}
              onClick={() => setShowRecoverConfirm(true)}
            >
              {recoverMutation.isPending ? <Spinner size="xs" className="mr-1" /> : <Undo2 className="h-3 w-3 mr-1" />}
              {t("recover")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[10px] px-2 text-terra hover:text-terra hover:bg-terra/10"
              disabled={purgeMutation.isPending}
              onClick={() => { setPurgeAllMode(false); setShowPurgeConfirm(true); setPurgeConfirmText(""); }}
            >
              {purgeMutation.isPending ? <Spinner size="xs" className="mr-1" /> : <Trash2 className="h-3 w-3 mr-1" />}
              {t("purge")}
            </Button>
          </div>
        )}
      </div>

      <div className="flex-1 flex flex-col sm:flex-row min-h-0">
        {/* Left sidebar: table list with trash counts (desktop) */}
        <div className="w-48 shrink-0 border-r border-border overflow-y-auto hidden sm:flex sm:flex-col">
          <div className="flex-1 p-2 space-y-0.5 overflow-y-auto">
            {isLoadingTrashTables ? (
              <div className="space-y-1.5 p-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
            ) : !trashTables?.length ? (
              <div className="px-3 py-8 text-center">
                <CheckCircle2 className="h-5 w-5 text-sodium/40 mx-auto mb-2" />
                <p className="text-[10px] text-cream/45">{t("noTablesWithSoftDelete")}</p>
                <p className="text-[10px] text-cream/35 mt-1">
                  {t.rich("softDeleteRequirement", {
                    code: (chunks) => <code className="text-sodium/60">{chunks}</code>,
                  })}
                </p>
              </div>
            ) : (
              trashTables.map((tbl) => (
                <button
                  key={tbl.table_name}
                  type="button"
                  onClick={() => { setTrashTable(tbl.table_name); setTrashPage(0); setTrashSearch(""); }}
                  className={cn(
                    "w-full flex items-center justify-between rounded-md px-2.5 py-1.5 text-left transition-colors",
                    trashTable === tbl.table_name ? "bg-sodium/10 text-sodium" : "text-cream/75 hover:bg-cream/[0.04]"
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Table2 className="h-3 w-3 shrink-0" />
                    <span className="text-xs font-mono truncate">{tbl.table_name}</span>
                  </div>
                  {tbl.deleted_count > 0 ? (
                    <Badge variant="outline" className="text-[9px] px-1 py-0 ml-1 shrink-0 tabular-nums text-terra border-terra/30">
                      {tbl.deleted_count}
                    </Badge>
                  ) : (
                    <span className="text-[9px] text-cream/35 ml-1 shrink-0">0</span>
                  )}
                </button>
              ))
            )}
          </div>
          {trashTables && trashTables.some((tbl) => tbl.deleted_count > 0) && trashTable && (
            <div className="shrink-0 border-t border-cream/[0.06] p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full h-7 text-[10px] text-terra/70 hover:text-terra hover:bg-terra/5 justify-start"
                disabled={purgeAllMutation.isPending}
                onClick={() => { setPurgeAllMode(true); setShowPurgeConfirm(true); setPurgeConfirmText(""); }}
              >
                {purgeAllMutation.isPending ? <Spinner size="xs" className="mr-1.5" /> : <Trash2 className="h-3 w-3 mr-1.5" />}
                {t("purgeAllInTable")}
              </Button>
            </div>
          )}
        </div>

        {/* Mobile: table selector dropdown */}
        <div className="sm:hidden shrink-0 border-b border-border px-3 py-2 flex items-center gap-2">
          {isLoadingTrashTables ? (
            <Skeleton className="h-7 flex-1" />
          ) : !trashTables?.length ? (
            <div className="flex-1 flex flex-col items-center py-4">
              <CheckCircle2 className="h-5 w-5 text-sodium/40 mb-1" />
              <span className="text-[10px] text-cream/45">{t("noSoftDeleteMobile")}</span>
            </div>
          ) : (
            <>
              <select
                value={trashTable ?? ""}
                onChange={(e) => { setTrashTable(e.target.value || null); setTrashPage(0); setTrashSearch(""); }}
                className="flex-1 h-8 text-xs bg-transparent border border-cream/[0.08] rounded-md px-2 text-cream/85"
              >
                <option value="">{t("selectTable")}</option>
                {trashTables.map((tbl) => (
                  <option key={tbl.table_name} value={tbl.table_name}>
                    {t("tableOptionLabel", { name: tbl.table_name, count: tbl.deleted_count })}
                  </option>
                ))}
              </select>
              {trashTable && trashTables.some((tbl) => tbl.table_name === trashTable && tbl.deleted_count > 0) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-[10px] text-terra/70 hover:text-terra shrink-0 px-2"
                  disabled={purgeAllMutation.isPending}
                  onClick={() => { setPurgeAllMode(true); setShowPurgeConfirm(true); setPurgeConfirmText(""); }}
                >
                  {purgeAllMutation.isPending ? <Spinner size="xs" /> : <Trash2 className="h-3 w-3" />}
                </Button>
              )}
            </>
          )}
        </div>

        {/* Main content: trash rows */}
        <div className="flex-1 flex flex-col min-h-0">
          <DatabaseBinContent
            trashTable={trashTable}
            trashRows={trashRows}
            trashTableColumns={trashTableColumns}
            trashPkColumns={trashPkColumns}
            trashTotalCount={trashTotalCount}
            trashTotalPages={trashTotalPages}
            trashPage={trashPage}
            trashSearch={trashSearch}
            trashSortDir={trashSortDir}
            trashSelected={trashSelected}
            isLoadingTrashData={isLoadingTrashData}
            isMutating={recoverMutation.isPending || purgeMutation.isPending}
            trashRowKey={trashRowKey}
            onSetTrashPage={setTrashPage}
            onSetTrashSortDir={setTrashSortDir}
            onTrashSelectAll={handleTrashSelectAll}
            onTrashToggleRow={handleTrashToggleRow}
            onRecoverSingle={handleRecoverSingle}
            onPurgeSingle={handlePurgeSingle}
            onClearSearch={() => { setTrashSearch(""); setTrashPage(0); }}
          />
        </div>
      </div>

      <RecoverDialog
        open={showRecoverConfirm}
        onOpenChange={setShowRecoverConfirm}
        selectedCount={trashSelected.size}
        pkColumns={trashPkColumns}
        isPending={recoverMutation.isPending}
        onConfirm={() => {
          if (!trashTable) return;
          const rows = getSelectedTrashRows();
          if (!rows.length) return;
          recoverMutation.mutate({ table: trashTable, rows, columns: trashTableColumns, pk: trashPkColumns ?? [] });
        }}
      />
      <PurgeDialog
        open={showPurgeConfirm}
        onOpenChange={(open) => { setShowPurgeConfirm(open); if (!open) { setPurgeConfirmText(""); setPurgeAllMode(false); } }}
        purgeAllMode={purgeAllMode}
        trashTable={trashTable}
        selectedCount={trashSelected.size}
        confirmText={purgeConfirmText}
        onConfirmTextChange={setPurgeConfirmText}
        isPending={purgeMutation.isPending || purgeAllMutation.isPending}
        onConfirm={() => {
          if (!trashTable) return;
          if (purgeAllMode) {
            purgeAllMutation.mutate({ table: trashTable });
          } else {
            const rows = getSelectedTrashRows();
            if (!rows.length) return;
            purgeMutation.mutate({ table: trashTable, rows, columns: trashTableColumns, pk: trashPkColumns ?? [] });
          }
        }}
      />
    </div>
  );
}
