// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Table2,
  Plus,
  Trash2,
  Check,
  X,
  Copy,
  Search,
  ArrowUp,
  ArrowDown,
  Rows3,
  Filter,
  Columns3,
  ChevronRight,
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type {
  DbApi,
  DbEntry,
  SchemaResponse,
  QueryResult,
  ColumnInfo,
  TableInfo,
  FilterOp,
  ColumnFilter,
} from "./database-types";
import {
  escSql,
  buildWhereClause,
  getTypeIcon,
  formatType,
  FILTER_OPS,
  PG_TYPES,
  PAGE_SIZE,
} from "./database-types";
import {
  CreateTableDialog,
  DropTableDialog,
  AddColumnDialog,
  AddRowDialog,
  DeleteRowDialog,
} from "./DatabaseTablesDialogs";
import { MobileOverview, MobileDetail, MobileStructure } from "./DatabaseTablesMobile";

interface DatabaseTablesProps {
  serverDomain: string;
  sandboxId: string;
  api: DbApi;
  selectedDb: DbEntry | null;
  schema: SchemaResponse | undefined;
  isLoadingSchema: boolean;
  tables: TableInfo[];
  // Currently selected table name (lifted to parent for cross-tab navigation)
  selectedTable: string | null;
  onSelectTable: (name: string | null) => void;
  onRefreshSchema: () => void;
  onRefreshDbs: () => void;
}

export function DatabaseTables({
  serverDomain,
  sandboxId,
  api,
  selectedDb,
  schema,
  isLoadingSchema,
  tables,
  selectedTable,
  onSelectTable,
  onRefreshSchema,
  onRefreshDbs,
}: DatabaseTablesProps) {
  const t = useTranslations("console.database.tables");
  // ── Table browsing state ──
  const [tableSearch, setTableSearch] = useState("");
  const [tableView, setTableView] = useState<"data" | "structure">("data");
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"ASC" | "DESC">("ASC");
  const [columnFilters, setColumnFilters] = useState<Record<string, ColumnFilter>>({});
  const [filterPopover, setFilterPopover] = useState<string | null>(null);
  const [filterDraftOp, setFilterDraftOp] = useState<FilterOp>("contains");
  const [filterDraftValue, setFilterDraftValue] = useState("");
  const filterPopoverRef = useRef<HTMLDivElement>(null);
  const [dataPage, setDataPage] = useState(0);
  const [pageInput, setPageInput] = useState("");

  // ── Keyboard navigation ──
  const [focusedCell, setFocusedCell] = useState<{ row: number; col: number } | null>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // ── Mobile column view ──
  const [mobileView, setMobileView] = useState<"overview" | "detail" | "structure" | "table">("overview");
  const [mobileColIndex, setMobileColIndex] = useState(0);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const mobileContainerRef = useRef<HTMLDivElement>(null);
  const [mobileSearch, setMobileSearch] = useState("");
  const [showMobileSearch, setShowMobileSearch] = useState(false);

  // ── Dialogs ──
  const [showCreateTable, setShowCreateTable] = useState(false);
  const [showDropTable, setShowDropTable] = useState(false);
  const [showAddColumn, setShowAddColumn] = useState(false);
  const [showAddRow, setShowAddRow] = useState(false);
  const [showDeleteRow, setShowDeleteRow] = useState<Record<string, string> | null>(null);
  const [showTableDropdown, setShowTableDropdown] = useState(false);
  const tableDropdownRef = useRef<HTMLDivElement>(null);

  // ── Create table form ──
  const [newTableName, setNewTableName] = useState("");
  const [newTableColumns, setNewTableColumns] = useState<Array<{ name: string; type: string; nullable: boolean; defaultVal: string }>>([
    { name: "id", type: "serial", nullable: false, defaultVal: "" },
  ]);
  const [openTypeDropdown, setOpenTypeDropdown] = useState<number | null>(null);

  // ── Add column form ──
  const [newColName, setNewColName] = useState("");
  const [newColType, setNewColType] = useState("text");
  const [newColNullable, setNewColNullable] = useState(true);
  const [newColDefault, setNewColDefault] = useState("");
  const [showAddColTypeDropdown, setShowAddColTypeDropdown] = useState(false);

  // ── Add row form ──
  const [newRowValues, setNewRowValues] = useState<Record<string, string>>({});

  // ── Inline editing ──
  const [editingCell, setEditingCell] = useState<{ rowIndex: number; column: string } | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingCell && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingCell]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (tableDropdownRef.current && !tableDropdownRef.current.contains(e.target as Node)) { setShowTableDropdown(false); setTableSearch(""); }
      if (filterPopoverRef.current && !filterPopoverRef.current.contains(e.target as Node)) setFilterPopover(null);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // ── API helpers ──

  const executeSql = async (sql: string): Promise<QueryResult> => {
    return api.executeSql(sandboxId, sql, selectedDb?.dbName);
  };

  const executeReadSql = async (sql: string): Promise<QueryResult> => {
    return api.executeReadSql(sandboxId, sql, selectedDb?.dbName);
  };

  // ── Derived ──

  const selectedTableInfo = tables.find((t) => t.name === selectedTable);
  const columns = selectedTableInfo?.columns ?? [];

  const filteredTables = useMemo(() => {
    if (!tableSearch) return tables;
    const s = tableSearch.toLowerCase();
    return tables.filter((t) => t.name.toLowerCase().includes(s));
  }, [tables, tableSearch]);

  const whereClause = useMemo(() => buildWhereClause(columnFilters), [columnFilters]);
  const filterKey = useMemo(() => JSON.stringify(columnFilters), [columnFilters]);

  const buildDataQuery = useCallback(() => {
    if (!selectedTable) return "";
    let sql = `SELECT * FROM "${selectedTable}"`;
    if (whereClause) sql += ` WHERE ${whereClause}`;
    if (sortColumn) sql += ` ORDER BY "${sortColumn}" ${sortDir}`;
    sql += ` LIMIT ${PAGE_SIZE} OFFSET ${dataPage * PAGE_SIZE}`;
    return sql;
  }, [selectedTable, whereClause, sortColumn, sortDir, dataPage]);

  const { data: tableData, isLoading: isLoadingData, isFetching: isFetchingData, refetch: refetchData } = useQuery<QueryResult>({
    queryKey: ["db-table-data", serverDomain, sandboxId, selectedDb?.dbName, selectedTable, sortColumn, sortDir, dataPage, filterKey],
    queryFn: async () => executeReadSql(buildDataQuery()),
    enabled: !!selectedDb && !!selectedTable && tableView === "data", staleTime: 10_000,
  });

  const { data: totalRowCount } = useQuery<number>({
    queryKey: ["db-table-count", serverDomain, sandboxId, selectedDb?.dbName, selectedTable, filterKey],
    queryFn: async () => {
      let sql = `SELECT COUNT(*) AS cnt FROM "${selectedTable}"`;
      if (whereClause) sql += ` WHERE ${whereClause}`;
      const result = await executeReadSql(sql);
      return parseInt(result.rows[0]?.cnt ?? "0", 10);
    },
    enabled: !!selectedDb && !!selectedTable && tableView === "data", staleTime: 15_000,
  });

  const totalPages = Math.max(1, Math.ceil((totalRowCount ?? 0) / PAGE_SIZE));
  const dataRows = tableData?.rows ?? [];
  const activeFilterCount = Object.keys(columnFilters).length;

  // ── Mutations ──

  const writeMutation = useMutation<QueryResult, Error, string>({
    mutationFn: (sql) => executeSql(sql),
    onSuccess: () => { onRefreshSchema(); if (selectedTable) refetchData(); },
  });

  // ── Auto-select first table ──
  useEffect(() => {
    if (!selectedTable && tables.length > 0) onSelectTable(tables[0]!.name);
  }, [tables, selectedTable, onSelectTable]);

  // ── Handlers ──

  const handleSelectTable = (name: string) => {
    onSelectTable(name); setTableView("data"); setSortColumn(null); setSortDir("ASC");
    setDataPage(0); setColumnFilters({}); setEditingCell(null); setFocusedCell(null);
  };

  const handleSort = (column: string) => {
    if (sortColumn === column) setSortDir((d) => (d === "ASC" ? "DESC" : "ASC"));
    else { setSortColumn(column); setSortDir("ASC"); }
    setDataPage(0);
  };

  const handleApplyFilter = (col: string) => {
    const op = filterDraftOp;
    const needsValue = FILTER_OPS.find((o) => o.value === op)?.needsValue ?? true;
    if (needsValue && !filterDraftValue.trim()) return;
    setColumnFilters((prev) => ({ ...prev, [col]: { op, value: filterDraftValue } }));
    setFilterPopover(null);
    setDataPage(0);
  };

  const handleClearFilter = (col: string) => {
    setColumnFilters((prev) => { const next = { ...prev }; delete next[col]; return next; });
    setFilterPopover(null);
    setDataPage(0);
  };

  const handleClearAllFilters = () => { setColumnFilters({}); setDataPage(0); };

  // ── Table CRUD ──

  const handleCreateTable = () => {
    if (!newTableName.trim() || newTableColumns.length === 0) return;
    const validCols = newTableColumns.filter((c) => c.name.trim());
    if (validCols.length === 0) { toast.error(t("atLeastOneColumnRequired")); return; }
    const cols = validCols.map((c) => {
      let def = `"${c.name}" ${c.type}`;
      if (!c.nullable) def += " NOT NULL";
      if (c.defaultVal.trim()) def += ` DEFAULT ${c.defaultVal}`;
      if (c.type === "serial" || c.type === "bigserial") def += " PRIMARY KEY";
      return def;
    }).join(", ");
    writeMutation.mutate(`CREATE TABLE "${newTableName.trim()}" (${cols})`, {
      onSuccess: () => {
        toast.success(t("tableCreated", { name: newTableName.trim() }));
        setShowCreateTable(false);
        setNewTableName("");
        setNewTableColumns([{ name: "id", type: "serial", nullable: false, defaultVal: "" }]);
        setOpenTypeDropdown(null);
      },
      onError: (err) => toast.error(err.message),
    });
  };

  const handleDropTable = () => {
    if (!selectedTable) return;
    writeMutation.mutate(`DROP TABLE "${selectedTable}" CASCADE`, {
      onSuccess: () => { toast.success(t("tableDropped", { name: selectedTable })); onSelectTable(null); setShowDropTable(false); onRefreshSchema(); },
      onError: (err) => toast.error(err.message),
    });
  };

  const handleAddColumn = () => {
    if (!selectedTable || !newColName.trim()) return;
    let sql = `ALTER TABLE "${selectedTable}" ADD COLUMN "${newColName.trim()}" ${newColType}`;
    if (!newColNullable) sql += " NOT NULL";
    if (newColDefault.trim()) sql += ` DEFAULT ${newColDefault.trim()}`;
    writeMutation.mutate(sql, {
      onSuccess: () => { toast.success(t("columnAdded", { name: newColName.trim() })); setShowAddColumn(false); setNewColName(""); setNewColType("text"); setNewColNullable(true); setNewColDefault(""); onRefreshSchema(); refetchData(); },
      onError: (err) => toast.error(err.message),
    });
  };

  const handleAddRow = () => {
    if (!selectedTable || !selectedTableInfo) return;
    const cols = Object.keys(newRowValues).filter((k) => newRowValues[k]?.trim());
    if (cols.length === 0) return;
    const colNames = cols.map((c) => `"${c}"`).join(", ");
    const colValues = cols.map((c) => {
      const v = newRowValues[c]!;
      if (v.toLowerCase() === "null") return "NULL";
      if (v.toLowerCase() === "true" || v.toLowerCase() === "false") return v;
      if (/^-?\d+(\.\d+)?$/.test(v)) return v;
      return `'${escSql(v)}'`;
    }).join(", ");
    writeMutation.mutate(`INSERT INTO "${selectedTable}" (${colNames}) VALUES (${colValues})`, {
      onSuccess: () => { toast.success(t("rowInserted")); setShowAddRow(false); setNewRowValues({}); refetchData(); onRefreshDbs(); },
      onError: (err) => toast.error(err.message),
    });
  };

  const handleDeleteRow = (row: Record<string, string>) => {
    if (!selectedTable || !selectedTableInfo) return;
    const conditions = selectedTableInfo.columns.map((col) => {
      const v = row[col.name];
      if (v === null || v === undefined) return `"${col.name}" IS NULL`;
      return `"${col.name}" = '${escSql(String(v))}'`;
    }).join(" AND ");
    writeMutation.mutate(`DELETE FROM "${selectedTable}" WHERE ${conditions} LIMIT 1`, {
      onSuccess: () => { toast.success(t("rowDeleted")); setShowDeleteRow(null); refetchData(); onRefreshDbs(); },
      onError: (err) => toast.error(err.message),
    });
  };

  // ── Inline edit ──

  const handleStartEdit = useCallback((rowIndex: number, column: string, currentValue: string) => {
    setEditingCell({ rowIndex, column }); setEditingValue(currentValue ?? "");
  }, []);

  const handleSaveEdit = () => {
    if (!editingCell || !selectedTable || !selectedTableInfo) return;
    const row = dataRows[editingCell.rowIndex];
    if (!row) return;
    const conditions = selectedTableInfo.columns.map((col) => {
      const v = row[col.name];
      if (v === null || v === undefined) return `"${col.name}" IS NULL`;
      return `"${col.name}" = '${escSql(String(v))}'`;
    }).join(" AND ");
    const newVal = editingValue.toLowerCase() === "null" ? "NULL" : `'${escSql(editingValue)}'`;
    writeMutation.mutate(`UPDATE "${selectedTable}" SET "${editingCell.column}" = ${newVal} WHERE ${conditions}`, {
      onSuccess: () => { setEditingCell(null); refetchData(); },
      onError: (err) => { toast.error(err.message); setEditingCell(null); },
    });
  };

  const handleCancelEdit = () => setEditingCell(null);

  const handleCopyCSV = () => {
    if (!dataRows.length || !selectedTableInfo) return;
    const headers = selectedTableInfo.columns.map((c) => c.name).join(",");
    const rows = dataRows.map((row) =>
      selectedTableInfo.columns.map((col) => {
        const v = row[col.name];
        if (v === null || v === undefined) return "";
        if (String(v).includes(",") || String(v).includes('"')) return `"${String(v).replace(/"/g, '""')}"`;
        return String(v);
      }).join(",")
    ).join("\n");
    navigator.clipboard.writeText(`${headers}\n${rows}`);
    toast.success(t("csvCopied"));
  };

  // ── Keyboard navigation ──

  const handleTableKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (editingCell) return;
    if (!selectedTableInfo || !dataRows.length) return;
    const maxRow = dataRows.length - 1;
    const maxCol = columns.length - 1;

    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab", "Enter"].includes(e.key)) {
      e.preventDefault();
      setFocusedCell((prev) => {
        const r = prev?.row ?? 0;
        const c = prev?.col ?? 0;
        switch (e.key) {
          case "ArrowUp": return { row: Math.max(0, r - 1), col: c };
          case "ArrowDown": return { row: Math.min(maxRow, r + 1), col: c };
          case "ArrowLeft": return { row: r, col: Math.max(0, c - 1) };
          case "ArrowRight": return { row: r, col: Math.min(maxCol, c + 1) };
          case "Tab":
            if (e.shiftKey) {
              if (c > 0) return { row: r, col: c - 1 };
              if (r > 0) return { row: r - 1, col: maxCol };
              return prev;
            }
            if (c < maxCol) return { row: r, col: c + 1 };
            if (r < maxRow) return { row: r + 1, col: 0 };
            return prev;
          case "Enter":
            if (prev) {
              const colName = columns[c]?.name;
              if (colName) handleStartEdit(r, colName, dataRows[r]?.[colName] ?? "");
            }
            return prev;
          default: return prev;
        }
      });
    }

    if (focusedCell && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const colName = columns[focusedCell.col]?.name;
      if (colName) {
        e.preventDefault();
        setEditingCell({ rowIndex: focusedCell.row, column: colName });
        setEditingValue(e.key);
      }
    }

    if (e.key === "Escape") setFocusedCell(null);
  }, [editingCell, selectedTableInfo, dataRows, columns, focusedCell, handleStartEdit]);

  // Scroll focused cell into view
  useEffect(() => {
    if (!focusedCell) return;
    const cell = tableContainerRef.current?.querySelector(`[data-cell="${focusedCell.row}-${focusedCell.col}"]`);
    cell?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focusedCell]);

  // ── Mobile helpers ──

  const handleMobileGlobalSearch = useCallback((query: string) => {
    if (!query.trim() || columns.length === 0) return;
    const q = query.toLowerCase();
    const nameMatch = columns.findIndex((c) => c.name.toLowerCase().includes(q));
    if (nameMatch >= 0) {
      setMobileColIndex(nameMatch);
      setColumnFilters((prev) => ({ ...prev, [columns[nameMatch]!.name]: { op: "contains", value: query } }));
      setDataPage(0);
      setMobileView("detail");
      setShowMobileSearch(false);
      return;
    }
    const currentCol = columns[mobileColIndex]?.name;
    if (currentCol) {
      setColumnFilters((prev) => ({ ...prev, [currentCol]: { op: "contains", value: query } }));
      setDataPage(0);
      setMobileView("detail");
    }
    setShowMobileSearch(false);
  }, [columns, mobileColIndex]);

  const handleMobileZoomIn = useCallback((colIndex: number) => {
    setMobileColIndex(colIndex);
    setMobileView("detail");
  }, []);

  const handleMobileZoomOut = useCallback(() => {
    setMobileView("overview");
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (touch) touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const touch = e.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    touchStartRef.current = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
    if (dx < 0 && mobileColIndex < columns.length - 1) setMobileColIndex((i) => i + 1);
    if (dx > 0 && mobileColIndex > 0) setMobileColIndex((i) => i - 1);
  }, [mobileColIndex, columns.length]);

  // Reset mobile state when table changes
  useEffect(() => { setMobileColIndex(0); setMobileView("overview"); }, [selectedTable]);

  const handleApplyFilterWithNav = useCallback((col: string) => {
    handleApplyFilter(col);
    const colIdx = columns.findIndex((c) => c.name === col);
    if (colIdx >= 0) {
      setMobileColIndex(colIdx);
      setMobileView("detail");
    }
  }, [columns, handleApplyFilter]);

  // ── Mobile props (shared across all mobile sub-views) ──
  const mobileProps = {
    columns, dataRows, isLoadingData, isFetchingData, selectedTable, selectedTableInfo,
    sortColumn, sortDir, columnFilters, activeFilterCount, dataPage, totalPages,
    editingCell, editingValue, filterPopover, filterDraftOp, filterDraftValue,
    onSort: handleSort, onSetDataPage: setDataPage, onSetMobileView: setMobileView,
    onStartEdit: handleStartEdit, onSaveEdit: handleSaveEdit, onCancelEdit: handleCancelEdit,
    onSetEditingValue: setEditingValue, onCopyCSV: handleCopyCSV,
    onShowAddRow: () => { setNewRowValues({}); setShowAddRow(true); },
    onShowAddColumn: () => setShowAddColumn(true), onShowDropTable: () => setShowDropTable(true),
    onShowDeleteRow: setShowDeleteRow, onClearAllFilters: handleClearAllFilters,
    onClearFilter: handleClearFilter, onApplyFilterWithNav: handleApplyFilterWithNav,
    onSetFilterPopover: setFilterPopover, onSetFilterDraftOp: setFilterDraftOp,
    onSetFilterDraftValue: setFilterDraftValue, editInputRef,
  } as const;

  // ── Render ──

  return (
    <div className="flex-1 flex flex-row min-h-0">
      {/* ── Left Sidebar: Table List ── */}
      <div className="hidden sm:flex w-52 shrink-0 flex-col border-r border-border bg-card/50">
        <div className="p-2 border-b border-cream/[0.06]">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <input type="text" value={tableSearch} onChange={(e) => setTableSearch(e.target.value)} placeholder={t("searchTables")} className="w-full h-7 text-[10px] bg-transparent pl-7 pr-2 border border-cream/[0.06] rounded-md text-cream/85 placeholder:text-cream/45 focus:outline-none focus:ring-1 focus:ring-sodium/50" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          {isLoadingSchema ? (
            <div className="p-2 space-y-1.5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
          ) : filteredTables.length === 0 ? (
            <div className="text-center py-6 px-2"><p className="text-[10px] text-cream/45">{tableSearch ? t("noMatchingTables") : t("noTablesYet")}</p></div>
          ) : (
            filteredTables.map((table) => (
              <button key={table.name} type="button" onClick={() => handleSelectTable(table.name)} className={cn("w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors mb-0.5", selectedTable === table.name ? "bg-sodium/10 text-sodium border border-sodium/20" : "text-cream/75 hover:bg-cream/[0.04]")}>
                <Table2 className="h-3 w-3 shrink-0" />
                <span className="text-[11px] font-mono truncate flex-1">{table.name}</span>
                <span className="text-[9px] text-cream/45 tabular-nums shrink-0">{table.rowCount}</span>
              </button>
            ))
          )}
        </div>
        <div className="p-1.5 border-t border-cream/[0.06]">
          <button type="button" onClick={() => setShowCreateTable(true)} className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-cream/60 hover:text-sodium hover:bg-cream/[0.04] transition-colors">
            <Plus className="h-3 w-3" /><span className="text-[10px]">{t("newTable")}</span>
          </button>
        </div>
      </div>

      {/* ── Right Content: Table Data ── */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {!selectedTable ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-14 h-14 rounded-2xl bg-cream/[0.03] border border-cream/[0.06] flex items-center justify-center mx-auto mb-4"><Table2 className="h-7 w-7 text-cream/35" /></div>
            <p className="text-sm text-cream/60 mb-1">{t("selectTablePrompt")}</p>
            <p className="text-[10px] text-cream/45 mb-4">{tables.length > 0 ? t("selectFromSidebar") : t("selectFromSidebarOrCreate")}</p>
            {tables.length === 0 && <Button size="sm" className="text-xs" onClick={() => setShowCreateTable(true)}><Plus className="h-3 w-3 mr-1.5" />{t("createTable")}</Button>}
          </div>
        </div>
      ) : (
        <>
          {/* Data view */}
          {tableView === "data" && (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Mobile: View toggle + search */}
              <div className="sm:hidden shrink-0 border-b border-cream/[0.06] bg-card/50">
                <div className="flex items-center justify-between px-3 py-1.5">
                  <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-cream/[0.03] border border-cream/[0.06]">
                    <button type="button" onClick={() => setMobileView("overview")} className={cn("flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors", mobileView !== "table" ? "bg-cream/[0.08] text-cream shadow-sm" : "text-cream/45 hover:text-cream/75")}><Columns3 className="h-3 w-3" />{t("columnsTab")}</button>
                    <button type="button" onClick={() => setMobileView("table")} className={cn("flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors", mobileView === "table" ? "bg-cream/[0.08] text-cream shadow-sm" : "text-cream/45 hover:text-cream/75")}><Rows3 className="h-3 w-3" />{t("tableTab")}</button>
                  </div>
                  <div className="flex items-center gap-2">
                    {activeFilterCount > 0 && <button type="button" onClick={handleClearAllFilters} className="text-[10px] text-sodium hover:text-sodium flex items-center gap-0.5"><X className="h-2.5 w-2.5" />{activeFilterCount}</button>}
                    <button type="button" onClick={() => setShowMobileSearch(!showMobileSearch)} className={cn("h-7 w-7 flex items-center justify-center rounded-md transition-colors", showMobileSearch ? "bg-cream/[0.08] text-sodium" : "text-cream/60 hover:text-cream/85")}><Search className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
                {showMobileSearch && (
                  <div className="px-3 pb-2">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                      <input type="text" value={mobileSearch} onChange={(e) => setMobileSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleMobileGlobalSearch(mobileSearch); }} placeholder={t("searchColumnsOrData")} autoFocus className="w-full h-8 text-xs bg-card/40 pl-8 pr-3 border border-cream/[0.08] rounded-lg text-cream/85 placeholder:text-cream/45 focus:outline-none focus:ring-1 focus:ring-sodium/50" />
                    </div>
                    <p className="text-[9px] text-cream/35 mt-1">{t("searchHint")}</p>
                  </div>
                )}
              </div>

              {/* ── Mobile Overview ── */}
              {mobileView === "overview" && (
                <div className="sm:hidden flex-1 flex flex-col min-h-0">
                  <MobileOverview {...mobileProps} mobileColIndex={mobileColIndex} onZoomIn={handleMobileZoomIn} />
                </div>
              )}

              {/* ── Mobile Detail ── */}
              {mobileView === "detail" && (
                <div className="sm:hidden flex-1 flex flex-col min-h-0">
                  <MobileDetail {...mobileProps} mobileColIndex={mobileColIndex} onSetMobileColIndex={setMobileColIndex} onZoomOut={handleMobileZoomOut} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} mobileContainerRef={mobileContainerRef} />
                </div>
              )}

              {/* ── Mobile Structure View ── */}
              {mobileView === "structure" && selectedTableInfo && (
                <div className="sm:hidden flex-1 flex flex-col min-h-0">
                  <MobileStructure selectedTable={selectedTable} selectedTableInfo={selectedTableInfo} onBack={() => setMobileView("overview")} onShowAddColumn={() => setShowAddColumn(true)} onShowDropTable={() => setShowDropTable(true)} />
                </div>
              )}

              {/* ── Desktop Table View (always) + Mobile Table View (when toggled) ── */}
              <div className={cn("flex-1 min-h-0", mobileView !== "table" ? "hidden sm:flex sm:flex-col" : "flex flex-col")}>
              <div ref={tableContainerRef} tabIndex={0} onKeyDown={handleTableKeyDown} className="flex-1 overflow-auto min-h-0 focus:outline-none">
              {isLoadingData ? (
                <div className="p-4 space-y-2">{Array.from({ length: 10 }).map((_, i) => <div key={i} className="flex items-center gap-3"><Skeleton className="h-4 w-24" /><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-20" /><Skeleton className="h-4 flex-1" /></div>)}</div>
              ) : (
                <>
                  <table className="w-full text-xs border-collapse min-w-[600px]">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-card border-b border-border">
                        <th className="w-10 px-2 py-1.5" />
                        {columns.map((col) => (
                          <th key={col.name} className="px-3 py-1.5 text-left font-medium text-cream/60 whitespace-nowrap select-none">
                            <div className="flex items-center gap-1">
                              <span className="cursor-pointer hover:text-cream/85 transition-colors" onClick={() => handleSort(col.name)}>
                                {col.name}
                                <span className="text-[9px] text-cream/35 ml-1">{formatType(col.type)}</span>
                              </span>
                              {sortColumn === col.name && (sortDir === "ASC" ? <ArrowUp className="h-2.5 w-2.5 text-sodium" /> : <ArrowDown className="h-2.5 w-2.5 text-sodium" />)}
                              {columnFilters[col.name] && <span className="w-1.5 h-1.5 rounded-full bg-sodium" />}
                              <div className="relative">
                                <button type="button" onClick={(e) => { e.stopPropagation(); if (filterPopover === col.name) { setFilterPopover(null); } else { setFilterPopover(col.name); setFilterDraftOp(columnFilters[col.name]?.op ?? "contains"); setFilterDraftValue(columnFilters[col.name]?.value ?? ""); } }} className={cn("h-4 w-4 p-0 rounded flex items-center justify-center transition-colors", filterPopover === col.name || columnFilters[col.name] ? "text-sodium" : "text-cream/35 hover:text-cream/60")}>
                                  <Filter className="h-2.5 w-2.5" />
                                </button>
                                {filterPopover === col.name && (
                                  <div ref={filterPopoverRef} className="absolute top-full left-0 mt-1 w-52 z-50 rounded-lg border border-cream/[0.08] bg-card shadow-2xl backdrop-blur-xl p-2.5 space-y-2" onClick={(e) => e.stopPropagation()}>
                                    <select value={filterDraftOp} onChange={(e) => setFilterDraftOp(e.target.value as FilterOp)} className="w-full h-7 text-[10px] bg-card/40 border border-input rounded-md px-2 text-cream/75">
                                      {FILTER_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </select>
                                    {FILTER_OPS.find((o) => o.value === filterDraftOp)?.needsValue !== false && (
                                      <input type="text" value={filterDraftValue} onChange={(e) => setFilterDraftValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleApplyFilter(col.name); }} placeholder={t("filterValuePlaceholder")} autoFocus className="w-full h-7 text-[10px] bg-card/40 border border-input rounded-md px-2 text-cream/75 placeholder:text-cream/45 focus:outline-none focus:ring-1 focus:ring-sodium/50" />
                                    )}
                                    <div className="flex items-center gap-1.5">
                                      <Button size="sm" className="h-6 text-[10px] flex-1" onClick={() => handleApplyFilter(col.name)}>{t("applyFilter")}</Button>
                                      {columnFilters[col.name] && <Button variant="ghost" size="sm" className="h-6 text-[10px] text-cream/60" onClick={() => handleClearFilter(col.name)}>{t("clearFilter")}</Button>}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {dataRows.length === 0 ? (
                        <tr><td colSpan={columns.length + 1} className="px-3 py-8 text-center text-cream/45">{activeFilterCount > 0 ? t("noMatchingRows") : t("emptyTable")}</td></tr>
                      ) : dataRows.map((row, i) => (
                        <tr key={i} className="border-b border-cream/[0.04] hover:bg-cream/[0.02] transition-colors group/row">
                          <td className="px-2 py-1">
                            <div className="opacity-0 group-hover/row:opacity-100 transition-opacity">
                              <button type="button" className="h-5 w-5 p-0 flex items-center justify-center text-cream/45 hover:text-terra" onClick={() => setShowDeleteRow(row)}><Trash2 className="h-2.5 w-2.5" /></button>
                            </div>
                          </td>
                          {columns.map((col, ci) => {
                            const isEditing = editingCell?.rowIndex === i && editingCell?.column === col.name;
                            const isFocused = focusedCell?.row === i && focusedCell?.col === ci;
                            return (
                              <td key={col.name} data-cell={`${i}-${ci}`} className={cn("px-3 py-1.5 font-mono whitespace-nowrap max-w-[300px]", isEditing ? "p-0" : "cursor-pointer", isFocused && !isEditing && "ring-1 ring-sodium/50 ring-inset")} onClick={() => setFocusedCell({ row: i, col: ci })} onDoubleClick={() => { if (!isEditing) handleStartEdit(i, col.name, row[col.name] ?? ""); }}>
                                {isEditing ? (
                                  <div className="flex items-center gap-0.5 px-1">
                                    <input ref={editInputRef} type="text" value={editingValue} onChange={(e) => setEditingValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { handleSaveEdit(); setFocusedCell({ row: Math.min(i + 1, dataRows.length - 1), col: ci }); } if (e.key === "Escape") handleCancelEdit(); if (e.key === "Tab") { e.preventDefault(); handleSaveEdit(); setFocusedCell({ row: i, col: ci + (e.shiftKey ? -1 : 1) }); } }} className="h-6 flex-1 text-xs font-mono bg-card/40 border border-sodium/50 rounded px-1.5 text-cream/85 focus:outline-none focus:ring-1 focus:ring-sodium/50 min-w-[60px]" />
                                    <Button variant="ghost" size="sm" className="h-5 w-5 p-0 text-sodium hover:text-sodium" onClick={handleSaveEdit}><Check className="h-2.5 w-2.5" /></Button>
                                    <Button variant="ghost" size="sm" className="h-5 w-5 p-0 text-cream/60 hover:text-cream/75" onClick={handleCancelEdit}><X className="h-2.5 w-2.5" /></Button>
                                  </div>
                                ) : row[col.name] === null || row[col.name] === undefined ? (
                                  <span className="text-cream/35 italic">{t("nullDisplay")}</span>
                                ) : (
                                  <span className="text-cream/75 truncate block">{row[col.name]}</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {/* Pagination */}
                  <div className="sticky bottom-0 flex items-center justify-between px-3 py-2 border-t border-border bg-card">
                    <span className="text-[10px] text-cream/45">
                      {totalRowCount != null
                        ? t("rowRange", { start: dataPage * PAGE_SIZE + 1, end: Math.min((dataPage + 1) * PAGE_SIZE, totalRowCount), total: totalRowCount.toLocaleString() })
                        : t("page", { page: dataPage + 1 })}
                    </span>
                    <div className="flex items-center gap-0.5">
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={dataPage === 0} onClick={() => setDataPage(0)}><ChevronsLeft className="h-3 w-3" /></Button>
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={dataPage === 0} onClick={() => setDataPage((p) => p - 1)}><ChevronLeft className="h-3 w-3" /></Button>
                      <input type="text" value={pageInput || String(dataPage + 1)} onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))} onBlur={() => { const p = parseInt(pageInput); if (p >= 1 && p <= totalPages) setDataPage(p - 1); setPageInput(""); }} onKeyDown={(e) => { if (e.key === "Enter") { const p = parseInt(pageInput); if (p >= 1 && p <= totalPages) setDataPage(p - 1); setPageInput(""); (e.target as HTMLInputElement).blur(); } }} className="w-10 h-6 text-center text-[10px] bg-transparent border border-cream/[0.06] rounded text-cream/75 focus:outline-none focus:ring-1 focus:ring-sodium/50" />
                      <span className="text-[10px] text-cream/45 mx-0.5">/ {totalPages}</span>
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={dataPage >= totalPages - 1} onClick={() => setDataPage((p) => p + 1)}><ChevronRight className="h-3 w-3" /></Button>
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={dataPage >= totalPages - 1} onClick={() => setDataPage(totalPages - 1)}><ChevronsRight className="h-3 w-3" /></Button>
                    </div>
                  </div>
                </>
              )}
              </div>
              </div>
            </div>
          )}

          {/* Structure view */}
          {tableView === "structure" && selectedTableInfo && (
            <div className="flex-1 overflow-auto min-h-0 p-4">
              <div className="max-w-3xl space-y-1">
                {selectedTableInfo.columns.map((col) => {
                  const Icon = getTypeIcon(col.type);
                  return (
                    <div key={col.name} className="flex items-center justify-between rounded-lg border border-cream/[0.06] bg-cream/[0.02] px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Icon className="h-3.5 w-3.5 text-cream/60" />
                        <span className="text-xs font-medium text-cream/85 font-mono">{col.name}</span>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">{formatType(col.type)}</Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        {col.nullable && <span className="text-[10px] text-cream/45">{t("nullable")}</span>}
                        {col.default && <span className="text-[10px] text-cream/45 font-mono truncate max-w-[180px]" title={col.default}>= {col.default}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 text-[10px] text-cream/45">{t("columnsCount", { columns: selectedTableInfo.columns.length, rows: selectedTableInfo.rowCount })}</div>
            </div>
          )}
        </>
      )}
      </div>

      {/* ── Dialogs ── */}
      <CreateTableDialog
        open={showCreateTable}
        onOpenChange={setShowCreateTable}
        dbLabel={selectedDb?.label}
        newTableName={newTableName}
        onTableNameChange={setNewTableName}
        newTableColumns={newTableColumns}
        onColumnsChange={setNewTableColumns}
        openTypeDropdown={openTypeDropdown}
        onTypeDropdownChange={setOpenTypeDropdown}
        onSubmit={handleCreateTable}
        isPending={writeMutation.isPending}
      />
      <DropTableDialog
        open={showDropTable}
        onOpenChange={setShowDropTable}
        tableName={selectedTable}
        onConfirm={handleDropTable}
        isPending={writeMutation.isPending}
      />
      <AddColumnDialog
        open={showAddColumn}
        onOpenChange={setShowAddColumn}
        tableName={selectedTable}
        colName={newColName}
        onColNameChange={setNewColName}
        colType={newColType}
        onColTypeChange={setNewColType}
        nullable={newColNullable}
        onNullableChange={setNewColNullable}
        defaultVal={newColDefault}
        onDefaultChange={setNewColDefault}
        showTypeDropdown={showAddColTypeDropdown}
        onTypeDropdownChange={setShowAddColTypeDropdown}
        onSubmit={handleAddColumn}
        isPending={writeMutation.isPending}
      />
      <AddRowDialog
        open={showAddRow}
        onOpenChange={setShowAddRow}
        tableName={selectedTable}
        tableInfo={selectedTableInfo}
        rowValues={newRowValues}
        onRowValuesChange={setNewRowValues}
        onSubmit={handleAddRow}
        isPending={writeMutation.isPending}
      />
      <DeleteRowDialog
        row={showDeleteRow}
        onOpenChange={setShowDeleteRow}
        onConfirm={handleDeleteRow}
        isPending={writeMutation.isPending}
      />
    </div>
  );
}
