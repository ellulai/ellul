// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Database,
  Table2,
  Plus,
  Trash2,
  Eye,
  Rocket,
  ChevronRight,
  HardDrive,
  RotateCcw,
  AlertCircle,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
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
  DbApi,
  DbEntry,
  BackupEntry,
  SchemaResponse,
  TableInfo,
} from "./database-types";
import { getTypeIcon, formatType, formatBytes } from "./database-types";

interface DatabaseSettingsProps {
  serverDomain: string;
  sandboxId: string;
  api: DbApi;
  selectedDb: DbEntry | null;
  dbList: DbEntry[];
  schema: SchemaResponse | undefined;
  isLoadingSchema: boolean;
  tables: TableInfo[];
  pgAvailable: boolean;
  onRefreshDbs: () => void;
  onRefreshSchema: () => void;
  onSelectTable: (name: string) => void;
  onSetActiveTab: (tab: "tables" | "sql" | "bin" | "settings") => void;
  onShowCreateDb: () => void;
  onShowDropDb: (db: DbEntry) => void;
  onShowCreateTable: () => void;
}

export function DatabaseSettings({
  serverDomain,
  sandboxId,
  api,
  selectedDb,
  dbList,
  schema,
  isLoadingSchema,
  tables,
  pgAvailable,
  onRefreshDbs,
  onRefreshSchema,
  onSelectTable,
  onSetActiveTab,
  onShowCreateDb,
  onShowDropDb,
  onShowCreateTable,
}: DatabaseSettingsProps) {
  const t = useTranslations("console.database.settings");
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [restoreTarget, setRestoreTarget] = useState<BackupEntry | null>(null);
  const [restoreConfirmText, setRestoreConfirmText] = useState("");

  const assignMutation = useMutation({
    mutationFn: ({ label, role }: { label: string | null; role: "preview" | "deployed" }) => api.assignDb(sandboxId, label, role),
    onSuccess: (_data, vars) => { onRefreshDbs(); toast.success(vars.role === "preview" ? t("developmentDbUpdated") : t("productionDbUpdated")); },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Backups ──

  const { data: backups, isLoading: isLoadingBackups, refetch: refetchBackups } = useQuery<BackupEntry[]>({
    queryKey: ["db-backups", serverDomain, sandboxId], queryFn: () => api.listBackups(sandboxId),
    enabled: pgAvailable, staleTime: 30_000,
  });

  const backupMutation = useMutation({
    mutationFn: () => api.createBackup(sandboxId),
    onSuccess: () => { refetchBackups(); toast.success(t("backupCreated")); },
    onError: (err: Error) => toast.error(err.message),
  });

  const restoreMutation = useMutation({
    mutationFn: (file: string) => api.restoreBackup(sandboxId, file),
    onSuccess: () => { onRefreshDbs(); onRefreshSchema(); refetchBackups(); setRestoreTarget(null); setRestoreConfirmText(""); toast.success(t("databaseRestored")); },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Database List */}
        <div>
          <h3 className="text-xs font-medium text-cream/85 mb-3">{t("databasesHeading")}</h3>
          <div className="space-y-2">
            {dbList.map((db) => (
              <div key={db.label} className="flex items-center justify-between rounded-lg border border-cream/[0.06] bg-cream/[0.02] px-4 py-3">
                <div className="flex items-center gap-3">
                  <Database className="h-4 w-4 text-sodium" />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-cream/85 font-mono">{db.label}</span>
                      {db.isPreview && <Badge className="bg-blue-500/10 text-blue-400 border-blue-500/30 text-[9px] px-1.5 py-0">{t("developmentBadge")}</Badge>}
                      {db.isDeployed && <Badge className="bg-sodium/10 text-sodium border-sodium/30 text-[9px] px-1.5 py-0">{t("productionBadge")}</Badge>}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-cream/45 font-mono">{db.dbName}</span>
                      <span className="text-[10px] text-cream/35">·</span>
                      <span className="text-[10px] text-cream/45">{formatBytes(db.sizeBytes)}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" className={cn("h-7 text-[10px] px-2", db.isPreview ? "text-blue-400 border-blue-500/30" : "text-cream/60")} onClick={() => assignMutation.mutate({ label: db.isPreview ? null : db.label, role: "preview" })}>
                    <Eye className="h-3 w-3 mr-1" />{db.isPreview ? t("unsetDev") : t("setDev")}
                  </Button>
                  <Button variant="outline" size="sm" className={cn("h-7 text-[10px] px-2", db.isDeployed ? "text-sodium border-sodium/30" : "text-cream/60")} onClick={() => assignMutation.mutate({ label: db.isDeployed ? null : db.label, role: "deployed" })}>
                    <Rocket className="h-3 w-3 mr-1" />{db.isDeployed ? t("unsetProd") : t("setProd")}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-cream/45 hover:text-terra" onClick={() => onShowDropDb(db)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
            ))}
          </div>
          <Button variant="outline" size="sm" className="mt-3 text-xs" onClick={onShowCreateDb}><Plus className="h-3 w-3 mr-1.5" />{t("newDatabase")}</Button>
        </div>

        {/* Schema Overview */}
        {selectedDb && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-medium text-cream/85">{t("schemaHeading", { label: selectedDb.label })}</h3>
              <Button variant="outline" size="sm" className="text-xs h-7" onClick={onShowCreateTable}><Plus className="h-3 w-3 mr-1.5" />{t("createTable")}</Button>
            </div>
            {isLoadingSchema ? (
              <div className="space-y-1.5">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
            ) : tables.length === 0 ? (
              <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] px-4 py-6 text-center"><p className="text-xs text-cream/45">{t("noTablesInDatabase")}</p></div>
            ) : (
              <div className="space-y-1">
                {tables.map((table) => {
                  const isExpanded = expandedTables.has(table.name);
                  return (
                    <div key={table.name} className="rounded-lg border border-cream/[0.06] bg-cream/[0.02]">
                      <button type="button" onClick={() => setExpandedTables((prev) => { const next = new Set(prev); if (next.has(table.name)) next.delete(table.name); else next.add(table.name); return next; })} className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-cream/[0.02] transition-colors">
                        <div className="flex items-center gap-2.5">
                          <ChevronRight className={cn("h-3 w-3 text-cream/45 transition-transform", isExpanded && "rotate-90")} />
                          <Table2 className="h-3.5 w-3.5 text-cream/60" />
                          <span className="text-xs font-medium text-cream/85 font-mono">{table.name}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-[10px] text-cream/45">{t("columnsCount", { count: table.columns.length })}</span>
                          <span className="text-[10px] text-cream/45">{t("rowsCount", { count: table.rowCount })}</span>
                          <Button variant="ghost" size="sm" className="h-5 text-[10px] text-cream/60 hover:text-sodium px-1.5" onClick={(e) => { e.stopPropagation(); onSelectTable(table.name); onSetActiveTab("tables"); }}>{t("browse")}</Button>
                        </div>
                      </button>
                      {isExpanded && (
                        <div className="border-t border-cream/[0.04] px-4 py-2 space-y-1">
                          {table.columns.map((col) => {
                            const Icon = getTypeIcon(col.type);
                            return (
                              <div key={col.name} className="flex items-center justify-between py-1">
                                <div className="flex items-center gap-2">
                                  <Icon className="h-3 w-3 text-cream/45" />
                                  <span className="text-[10px] font-mono text-cream/75">{col.name}</span>
                                  <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono">{formatType(col.type)}</Badge>
                                </div>
                                <div className="flex items-center gap-2">
                                  {!col.nullable && <span className="text-[9px] text-sodium/70">{t("notNull")}</span>}
                                  {col.default && <span className="text-[9px] text-cream/45 font-mono truncate max-w-[120px]">= {col.default}</span>}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Connection Info */}
        <div>
          <h3 className="text-xs font-medium text-cream/85 mb-3">{t("connectionHeading")}</h3>
          <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-2">
            {([
              ["engineLabel", "engineValue"],
              ["hostLabel", "hostValue"],
              ["portLabel", "portValue"],
              ["authLabel", "authValue"],
            ] as const).map(([labelKey, valueKey]) => (
              <div key={labelKey} className="flex items-center justify-between">
                <span className="text-[10px] text-cream/60">{t(labelKey)}</span>
                <span className="text-[10px] text-cream/75 font-mono">{t(valueKey)}</span>
              </div>
            ))}
            <p className="text-[10px] text-cream/45 pt-1 border-t border-cream/[0.04]">{t("databaseUrlAutoInjected")}</p>
          </div>
        </div>

        {/* Backups */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-medium text-cream/85">{t("backupsHeading")}</h3>
            <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => backupMutation.mutate()} disabled={backupMutation.isPending}>
              {backupMutation.isPending ? <Spinner size="xs" className="mr-1.5" /> : <HardDrive className="h-3 w-3 mr-1.5" />}{t("createBackup")}
            </Button>
          </div>
          <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02]">
            {isLoadingBackups ? (
              <div className="p-4 space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
            ) : !backups?.length ? (
              <div className="px-4 py-6 text-center">
                <p className="text-xs text-cream/45">{t("noBackupsTitle")}</p>
                <p className="text-[10px] text-cream/35 mt-1">{t("noBackupsHint")}</p>
              </div>
            ) : (
              <div className="divide-y divide-cream/[0.04]">
                {backups.map((backup) => {
                  const name = typeof backup === "string" ? backup : backup.file;
                  const size = typeof backup === "string" ? 0 : backup.sizeBytes;
                  const match = name.match(/_(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
                  const dateStr = match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}` : "";
                  return (
                    <div key={name} className="flex items-center justify-between px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <HardDrive className="h-3.5 w-3.5 text-cream/60" />
                        <div>
                          <span className="text-xs text-cream/75 font-mono">{name}</span>
                          <div className="flex items-center gap-2 mt-0.5">
                            {dateStr && <span className="text-[10px] text-cream/45">{dateStr}</span>}
                            {size > 0 && <span className="text-[10px] text-cream/45">{formatBytes(size)}</span>}
                          </div>
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" className="h-6 text-[10px] text-cream/60 hover:text-sodium" onClick={() => { setRestoreTarget(typeof backup === "string" ? { file: backup, sizeBytes: 0 } : backup); setRestoreConfirmText(""); }}>
                        <RotateCcw className="h-3 w-3 mr-1" />{t("restore")}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <p className="text-[10px] text-cream/45 mt-2">{t("backupsLocation")}</p>
        </div>
      </div>

      {/* Restore backup confirmation */}
      {restoreTarget && (
        <Dialog open={!!restoreTarget} onOpenChange={() => { setRestoreTarget(null); setRestoreConfirmText(""); }}>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-sodium"><RotateCcw className="h-5 w-5" />{t("restoreTitle")}</DialogTitle>
              <DialogDescription>{t("restoreDescription")}</DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-3">
              <div className="flex items-center gap-2.5">
                <HardDrive className="h-3.5 w-3.5 text-cream/60" />
                <span className="text-xs text-cream/75 font-mono">{restoreTarget.file}</span>
                <span className="text-[10px] text-cream/45">{formatBytes(restoreTarget.sizeBytes)}</span>
              </div>
            </div>
            <div>
              <Label className="text-xs text-cream/75">{t("typeRestoreLabel")}</Label>
              <Input value={restoreConfirmText} onChange={(e) => setRestoreConfirmText(e.target.value)} placeholder={t("restorePlaceholder")} className="mt-1 bg-card/40 text-sm font-mono" />
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => { setRestoreTarget(null); setRestoreConfirmText(""); }}>{t("cancel")}</Button>
              <Button disabled={restoreConfirmText !== "RESTORE" || restoreMutation.isPending} onClick={() => restoreMutation.mutate(restoreTarget.file)}>
                {restoreMutation.isPending ? <Spinner size="xs" className="mr-1.5" /> : <RotateCcw className="h-3.5 w-3.5 mr-1.5" />}{t("restoreConfirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
