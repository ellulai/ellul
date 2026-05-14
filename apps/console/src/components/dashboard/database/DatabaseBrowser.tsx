// SPDX-License-Identifier: MIT
"use client";

import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Database,
  Table2,
  Plus,
  Trash2,
  Check,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Search,
  Code2,
  Settings,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type {
  DatabaseBrowserProps,
  DbApi,
  DbEntry,
  DbTab,
  SchemaResponse,
} from "./database-types";
import { formatBytes } from "./database-types";
import { useDirectDbApi, useBridgeDbApi } from "./use-database-api";
import { DatabaseBrowserLite } from "./DatabaseBrowserLite";
import { DatabaseTables } from "./DatabaseTables";
import { DatabaseSql } from "./DatabaseSql";
import { DatabaseBin } from "./DatabaseBin";
import { DatabaseSettings } from "./DatabaseSettings";

// ── Public entry point ──

export function DatabaseBrowser({ serverDomain, sandboxId, tier, activeTab: externalTab }: DatabaseBrowserProps) {
  if (tier !== "standard") {
    return <DatabaseBrowserBridge serverDomain={serverDomain} sandboxId={sandboxId} externalTab={externalTab} />;
  }
  return <DatabaseBrowserDirect serverDomain={serverDomain} sandboxId={sandboxId} externalTab={externalTab} />;
}

function DatabaseBrowserBridge({ serverDomain, sandboxId, externalTab }: { serverDomain: string; sandboxId: string; externalTab?: DbTab }) {
  const api = useBridgeDbApi();
  return <DatabaseBrowserInner serverDomain={serverDomain} sandboxId={sandboxId} api={api} externalTab={externalTab} />;
}

function DatabaseBrowserDirect({ serverDomain, sandboxId, externalTab }: { serverDomain: string; sandboxId: string; externalTab?: DbTab }) {
  const api = useDirectDbApi(`https://${serverDomain}`);
  return <DatabaseBrowserInner serverDomain={serverDomain} sandboxId={sandboxId} api={api} externalTab={externalTab} />;
}

// ── Main inner component: header + tab routing ──

function DatabaseBrowserInner({ serverDomain, sandboxId, api, externalTab }: { serverDomain: string; sandboxId: string; api: DbApi; externalTab?: DbTab }) {
  const t = useTranslations("console.database.browser");
  const queryClient = useQueryClient();

  // ── Tab state ──
  const [internalTab, setInternalTab] = useState<DbTab>("tables");
  const activeTab = externalTab ?? internalTab;
  const setActiveTab = (tab: DbTab) => setInternalTab(tab);

  // ── Database selection ──
  const [selectedDb, setSelectedDb] = useState<DbEntry | null>(null);
  const [showDbDropdown, setShowDbDropdown] = useState(false);
  const [showTableDropdown, setShowTableDropdown] = useState(false);
  const [tableSearch, setTableSearch] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const tableDropdownRef = useRef<HTMLDivElement>(null);

  // ── Table selection (shared across tabs) ──
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableView, setTableView] = useState<"data" | "structure">("data");

  // ── Dialogs (shared) ──
  const [showCreateDb, setShowCreateDb] = useState(false);
  const [showDropDb, setShowDropDb] = useState<DbEntry | null>(null);
  const [showCreateTable, setShowCreateTable] = useState(false);
  const [newDbLabel, setNewDbLabel] = useState("");

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setShowDbDropdown(false);
      if (tableDropdownRef.current && !tableDropdownRef.current.contains(e.target as Node)) { setShowTableDropdown(false); setTableSearch(""); }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // ── Queries ──

  const { data: pgStatus, isLoading: isCheckingPg } = useQuery<{ available: boolean }>({
    queryKey: ["db-status", serverDomain], queryFn: () => api.checkStatus(), staleTime: 30_000, retry: 1,
  });

  const pgAvailable = pgStatus?.available ?? false;

  const { data: databases, isLoading: isLoadingDbs, refetch: refetchDbs, error: dbsError } = useQuery<DbEntry[]>({
    queryKey: ["db-list", serverDomain, sandboxId], queryFn: () => api.listDatabases(sandboxId), staleTime: 15_000, enabled: pgAvailable,
  });

  const { data: schema, isLoading: isLoadingSchema, refetch: refetchSchema } = useQuery<SchemaResponse>({
    queryKey: ["db-schema", serverDomain, sandboxId, selectedDb?.dbName],
    queryFn: () => api.getSchema(sandboxId, selectedDb!.dbName), enabled: !!selectedDb, staleTime: 30_000,
  });

  const tables = schema?.tables ?? [];
  const dbList = databases ?? [];

  const filteredTables = useMemo(() => {
    if (!tableSearch) return tables;
    const s = tableSearch.toLowerCase();
    return tables.filter((t) => t.name.toLowerCase().includes(s));
  }, [tables, tableSearch]);

  // ── Mutations (shared) ──

  const createDbMutation = useMutation({
    mutationFn: (label: string) => api.createDb(sandboxId, label),
    onSuccess: () => { refetchDbs(); setShowCreateDb(false); setNewDbLabel(""); toast.success(t("createSuccess")); },
    onError: (err: Error) => toast.error(err.message),
  });

  const dropDbMutation = useMutation({
    mutationFn: (label: string) => api.dropDb(sandboxId, label),
    onSuccess: () => {
      if (selectedDb && showDropDb && selectedDb.label === showDropDb.label) { setSelectedDb(null); setSelectedTable(null); }
      refetchDbs(); setShowDropDb(null); toast.success(t("deleteSuccess"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Auto-select first database ──
  useEffect(() => {
    if (!selectedDb && dbList.length > 0) setSelectedDb(dbList[0]!);
  }, [dbList, selectedDb]);

  // ── Handlers ──

  const handleSelectDb = (db: DbEntry) => {
    setSelectedDb(db); setSelectedTable(null); setTableView("data");
    setShowDbDropdown(false);
  };

  const handleSelectTable = useCallback((name: string | null) => {
    setSelectedTable(name);
    if (name !== null) setTableView("data");
  }, []);

  const handleRefreshAll = () => { refetchDbs(); refetchSchema(); };

  // ── Render: Loading / Error / Empty states ──

  if (isCheckingPg || isLoadingDbs) {
    return (
      <div className="flex-1 flex flex-col min-h-0 bg-card">
        <div className="shrink-0 px-4 py-3 border-b border-border"><Skeleton className="h-8 w-48" /></div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center"><Spinner size="default" className="mx-auto mb-3" /><p className="text-xs text-cream/60">{t("loadingDatabases")}</p></div>
        </div>
      </div>
    );
  }

  if (pgStatus && !pgStatus.available) {
    return (
      <div className="flex-1 flex items-center justify-center bg-card">
        <div className="text-center max-w-sm p-4">
          <div className="w-14 h-14 rounded-2xl bg-sodium/10 border border-sodium/20 flex items-center justify-center mx-auto mb-4"><Database className="h-7 w-7 text-sodium" /></div>
          <h3 className="text-sm font-medium text-cream/85 mb-1">{t("pgUnavailableTitle")}</h3>
          <p className="text-xs text-cream/60 mb-4">{t("pgUnavailableDescription")}</p>
          <Button variant="outline" size="sm" onClick={() => queryClient.invalidateQueries({ queryKey: ["db-status", serverDomain] })}><RefreshCw className="h-3 w-3 mr-1.5" />{t("checkAgain")}</Button>
        </div>
      </div>
    );
  }

  if (dbsError) {
    return (
      <div className="flex-1 flex items-center justify-center bg-card">
        <div className="text-center max-w-sm p-4">
          <div className="w-14 h-14 rounded-2xl bg-terra/10 border border-terra/20 flex items-center justify-center mx-auto mb-4"><AlertCircle className="h-7 w-7 text-terra" /></div>
          <h3 className="text-sm font-medium text-cream/85 mb-1">{t("errorTitle")}</h3>
          <p className="text-xs text-cream/60 mb-4">{dbsError instanceof Error ? dbsError.message : t("errorFallback")}</p>
          <Button variant="outline" size="sm" onClick={() => refetchDbs()}><RefreshCw className="h-3 w-3 mr-1.5" />{t("retry")}</Button>
        </div>
      </div>
    );
  }

  if (dbList.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-card">
        <div className="text-center max-w-sm p-4">
          <div className="w-14 h-14 rounded-2xl bg-sodium/10 border border-sodium/20 flex items-center justify-center mx-auto mb-4"><Database className="h-7 w-7 text-sodium" /></div>
          <h3 className="text-sm font-medium text-cream/85 mb-1">{t("noDatabasesTitle")}</h3>
          <p className="text-xs text-cream/60 mb-4">
            {t.rich("noDatabasesHint", {
              code: (chunks) => <code className="font-mono text-[10.5px] text-cream/75">{chunks}</code>,
            })}
          </p>
          <Button size="sm" onClick={() => setShowCreateDb(true)}><Plus className="h-3 w-3 mr-1.5" />{t("createDatabase")}</Button>
        </div>
        {renderSharedDialogs()}
      </div>
    );
  }

  // ── Render: Main Layout ──

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-card">
      {/* ── Header ── */}
      <div className="shrink-0 border-b border-border">
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
          {/* Sandbox scope indicator — DBs are per-sandbox, shared by every app inside */}
          <div
            className="flex items-center gap-1.5 rounded-md border border-cream/[0.06] bg-cream/[0.02] px-2 py-1"
            title={t("sandboxTitle", { sandboxId })}
          >
            <span className="text-[10px] uppercase tracking-wider text-cream/45">{t("sandboxLabel")}</span>
            <code className="text-[11px] font-mono text-cream/75">{sandboxId}</code>
          </div>
          {/* Database Dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button type="button" onClick={() => setShowDbDropdown(!showDbDropdown)} className="flex items-center gap-2 rounded-lg border border-cream/[0.08] bg-cream/[0.03] hover:bg-cream/[0.06] px-3 py-1.5 transition-colors">
              <Database className="h-3.5 w-3.5 text-sodium" />
              <span className="text-xs font-medium text-cream/85 font-mono">{selectedDb?.label ?? t("select")}</span>
              {selectedDb?.isPreview && <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/30 text-[9px] px-1 py-0 hidden sm:inline-flex">{t("devBadge")}</Badge>}
              {selectedDb?.isDeployed && <Badge className="bg-sodium/10 text-sodium border-sodium/30 text-[9px] px-1 py-0 hidden sm:inline-flex">{t("prodBadge")}</Badge>}
              <ChevronDown className={cn("h-3 w-3 text-cream/45 transition-transform", showDbDropdown && "rotate-180")} />
            </button>
            {showDbDropdown && (
              <div className="absolute top-full left-0 mt-1 w-64 z-50 rounded-lg border border-cream/[0.08] bg-card shadow-2xl backdrop-blur-xl">
                <div className="p-1.5 max-h-64 overflow-y-auto">
                  {dbList.map((db) => (
                    <button key={db.label} type="button" onClick={() => handleSelectDb(db)} className={cn("w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors", selectedDb?.label === db.label ? "bg-sodium/10 text-sodium" : "text-cream/75 hover:bg-cream/[0.04]")}>
                      <Database className="h-3.5 w-3.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium font-mono truncate">{db.label}</span>
                          {db.isPreview && <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/30 text-[9px] px-1 py-0">{t("devBadge")}</Badge>}
                          {db.isDeployed && <Badge className="bg-sodium/10 text-sodium border-sodium/30 text-[9px] px-1 py-0">{t("prodBadge")}</Badge>}
                        </div>
                        <span className="text-[10px] text-cream/45">{formatBytes(db.sizeBytes)}</span>
                      </div>
                      {selectedDb?.label === db.label && <Check className="h-3 w-3 text-sodium shrink-0" />}
                    </button>
                  ))}
                </div>
                <div className="border-t border-cream/[0.06] p-1.5">
                  <button type="button" onClick={() => { setShowDbDropdown(false); setShowCreateDb(true); }} className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-cream/60 hover:text-sodium hover:bg-cream/[0.04] transition-colors">
                    <Plus className="h-3 w-3" /><span className="text-xs">{t("newDatabase")}</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          <ChevronRight className="h-3 w-3 text-cream/35 shrink-0" />

          {/* Table Dropdown (Tables tab, mobile only) */}
          {activeTab === "tables" && (
            <div className="relative sm:hidden" ref={tableDropdownRef}>
              <button type="button" onClick={() => { setShowTableDropdown(!showTableDropdown); setTableSearch(""); }} className="flex items-center gap-2 rounded-lg border border-cream/[0.08] bg-cream/[0.03] hover:bg-cream/[0.06] px-3 py-1.5 transition-colors">
                <Table2 className="h-3.5 w-3.5 text-cream/60" />
                <span className="text-xs font-medium text-cream/85 font-mono truncate max-w-[120px]">{selectedTable ?? t("selectTable")}</span>
                <ChevronDown className={cn("h-3 w-3 text-cream/45 transition-transform", showTableDropdown && "rotate-180")} />
              </button>
              {showTableDropdown && (
                <div className="absolute top-full left-0 mt-1 w-60 z-50 rounded-lg border border-cream/[0.08] bg-card shadow-2xl backdrop-blur-xl">
                  <div className="p-1.5 border-b border-cream/[0.06]">
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                      <input type="text" value={tableSearch} onChange={(e) => setTableSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && filteredTables.length > 0) { handleSelectTable(filteredTables[0]!.name); setShowTableDropdown(false); setTableSearch(""); } }} placeholder={t("filterTables")} autoFocus className="w-full h-7 text-[10px] bg-transparent pl-7 pr-2 border border-cream/[0.06] rounded-md text-cream/85 placeholder:text-cream/45 focus:outline-none focus:ring-1 focus:ring-sodium/50" />
                    </div>
                  </div>
                  <div className="p-1.5 max-h-64 overflow-y-auto">
                    {isLoadingSchema ? (
                      <div className="p-2 space-y-1.5">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
                    ) : filteredTables.length === 0 ? (
                      <div className="text-center py-4 px-2"><p className="text-[10px] text-cream/45">{tableSearch ? t("noMatchingTables") : t("noTablesYet")}</p></div>
                    ) : (
                      filteredTables.map((table) => (
                        <button key={table.name} type="button" onClick={() => { handleSelectTable(table.name); setShowTableDropdown(false); setTableSearch(""); }} className={cn("w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors", selectedTable === table.name ? "bg-sodium/10 text-sodium" : "text-cream/75 hover:bg-cream/[0.04]")}>
                          <Table2 className="h-3 w-3 shrink-0" />
                          <span className="text-xs font-mono truncate flex-1">{table.name}</span>
                          <span className="text-[10px] text-cream/45 tabular-nums shrink-0">{table.rowCount}</span>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="border-t border-cream/[0.06] p-1.5">
                    <button type="button" onClick={() => { setShowTableDropdown(false); setShowCreateTable(true); }} className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-cream/60 hover:text-sodium hover:bg-cream/[0.04] transition-colors">
                      <Plus className="h-3 w-3" /><span className="text-xs">{t("createTable")}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Tab Bar */}
          {!externalTab && (
            <>
              <div className="h-5 w-px bg-cream/[0.06]" />
              <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-cream/[0.03] border border-cream/[0.06]">
                {([
                  { id: "tables" as DbTab, labelKey: "tabTables" as const, icon: Table2 },
                  { id: "sql" as DbTab, labelKey: "tabSql" as const, icon: Code2 },
                  { id: "bin" as DbTab, labelKey: "tabBin" as const, icon: Trash2 },
                  { id: "settings" as DbTab, labelKey: "tabSettings" as const, icon: Settings },
                ]).map(({ id, labelKey, icon: Icon }) => (
                  <button key={id} type="button" onClick={() => setActiveTab(id)} className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors", activeTab === id ? "bg-cream/[0.08] text-cream shadow-sm" : "text-cream/45 hover:text-cream/75")}>
                    <Icon className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{t(labelKey)}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Right side actions */}
          <div className="ml-auto flex items-center gap-1">
            <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-cream/60 hover:text-cream/85" onClick={handleRefreshAll}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger><TooltipContent>{t("refresh")}</TooltipContent></Tooltip></TooltipProvider>
          </div>
        </div>
      </div>

      {/* ── Tab Content ── */}
      {activeTab === "tables" && (
        <DatabaseTables
          serverDomain={serverDomain}
          sandboxId={sandboxId}
          api={api}
          selectedDb={selectedDb}
          schema={schema}
          isLoadingSchema={isLoadingSchema}
          tables={tables}
          selectedTable={selectedTable}
          onSelectTable={handleSelectTable}
          onRefreshSchema={() => refetchSchema()}
          onRefreshDbs={() => refetchDbs()}
        />
      )}

      {activeTab === "sql" && (
        <DatabaseSql
          api={api}
          sandboxId={sandboxId}
          selectedDb={selectedDb}
          onDataChanged={() => { refetchSchema(); refetchDbs(); }}
        />
      )}

      {activeTab === "bin" && (
        <DatabaseBin
          serverDomain={serverDomain}
          sandboxId={sandboxId}
          api={api}
          selectedDb={selectedDb}
          schema={schema}
          onRefreshData={() => { refetchSchema(); refetchDbs(); }}
        />
      )}

      {activeTab === "settings" && (
        <DatabaseSettings
          serverDomain={serverDomain}
          sandboxId={sandboxId}
          api={api}
          selectedDb={selectedDb}
          dbList={dbList}
          schema={schema}
          isLoadingSchema={isLoadingSchema}
          tables={tables}
          pgAvailable={pgAvailable}
          onRefreshDbs={() => refetchDbs()}
          onRefreshSchema={() => refetchSchema()}
          onSelectTable={(name) => { setSelectedTable(name); setTableView("data"); }}
          onSetActiveTab={setActiveTab}
          onShowCreateDb={() => setShowCreateDb(true)}
          onShowDropDb={(db) => setShowDropDb(db)}
          onShowCreateTable={() => setShowCreateTable(true)}
        />
      )}

      {renderSharedDialogs()}
    </div>
  );

  function renderSharedDialogs() {
    const dropAssignment = showDropDb && (showDropDb.isPreview && showDropDb.isDeployed
      ? "dropAssignedBoth"
      : showDropDb.isPreview
        ? "dropAssignedDev"
        : "dropAssignedProd") as "dropAssignedBoth" | "dropAssignedDev" | "dropAssignedProd";
    return (
      <>
        {/* Create Database */}
        <Dialog open={showCreateDb} onOpenChange={setShowCreateDb}>
          <DialogContent className="sm:max-w-[400px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><Plus className="h-5 w-5 text-sodium" />{t("createDialogTitle")}</DialogTitle>
              <DialogDescription>{t("createDialogDescription")}</DialogDescription>
            </DialogHeader>
            <div>
              <label className="text-xs text-cream/75">{t("databaseLabel")}</label>
              <Input value={newDbLabel} onChange={(e) => setNewDbLabel(e.target.value.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase())} placeholder={t("databaseLabelPlaceholder")} className="mt-1 bg-card/40 text-sm font-mono" maxLength={32} />
              <p className="text-[10px] text-cream/45 mt-1">{t("databaseLabelHint")}</p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCreateDb(false)}>{t("cancel")}</Button>
              <Button onClick={() => createDbMutation.mutate(newDbLabel)} disabled={!newDbLabel.trim() || createDbMutation.isPending}>
                {createDbMutation.isPending ? <Spinner size="xs" className="mr-1.5" /> : <Plus className="h-3 w-3 mr-1.5" />}{t("create")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Drop Database */}
        {showDropDb && (
          <Dialog open={!!showDropDb} onOpenChange={() => setShowDropDb(null)}>
            <DialogContent className="sm:max-w-[400px]">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-terra"><AlertCircle className="h-5 w-5" />{t("dropDialogTitle")}</DialogTitle>
                <DialogDescription>
                  {t.rich("dropDialogDescription", {
                    label: showDropDb.label,
                    strong: (chunks) => <strong className="text-cream/85">{chunks}</strong>,
                  })}
                </DialogDescription>
              </DialogHeader>
              {(showDropDb.isPreview || showDropDb.isDeployed) && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-sodium/10 border border-sodium/20">
                  <AlertCircle className="h-4 w-4 text-sodium shrink-0 mt-0.5" />
                  <p className="text-xs text-sodium">{t(dropAssignment!)}</p>
                </div>
              )}
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setShowDropDb(null)}>{t("cancel")}</Button>
                <Button variant="destructive" onClick={() => dropDbMutation.mutate(showDropDb.label)} disabled={dropDbMutation.isPending}>
                  {dropDbMutation.isPending ? <Spinner size="xs" className="mr-1.5" /> : <Trash2 className="h-3.5 w-3.5 mr-1.5" />}{t("deleteForever")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </>
    );
  }
}
