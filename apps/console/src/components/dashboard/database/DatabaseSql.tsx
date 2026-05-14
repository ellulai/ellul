// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Play,
  ChevronRight,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DbApi, DbEntry, QueryResult } from "./database-types";
import { isDestructiveSql } from "./database-types";

interface DatabaseSqlProps {
  api: DbApi;
  sandboxId: string;
  selectedDb: DbEntry | null;
  onDataChanged: () => void;
}

export function DatabaseSql({ api, sandboxId, selectedDb, onDataChanged }: DatabaseSqlProps) {
  const t = useTranslations("console.database.sql");
  const [customQuery, setCustomQuery] = useState("");
  const [pendingDestructiveSql, setPendingDestructiveSql] = useState<string | null>(null);
  const [destructiveConfirmText, setDestructiveConfirmText] = useState("");

  const executeSql = async (sql: string): Promise<QueryResult> => {
    return api.executeSql(sandboxId, sql, selectedDb?.dbName);
  };

  const queryMutation = useMutation<QueryResult, Error, string>({
    mutationFn: (sql) => executeSql(sql),
  });

  const executeQuery = (sql: string) => {
    queryMutation.mutate(sql, {
      onSuccess: (data) => {
        if (data.category && data.category !== "read") {
          onDataChanged();
        }
      },
    });
  };

  const handleRunQuery = () => {
    if (!customQuery.trim()) return;
    const sql = customQuery.trim();
    if (isDestructiveSql(sql)) {
      setPendingDestructiveSql(sql);
      setDestructiveConfirmText("");
      return;
    }
    executeQuery(sql);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 border-b border-border">
        <div className="p-3">
          <Textarea value={customQuery} onChange={(e) => setCustomQuery(e.target.value)} placeholder={t("queryPlaceholder")} className="h-20 sm:h-28 text-xs font-mono bg-card/40 resize-none" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); handleRunQuery(); } }} />
          <div className="flex items-center justify-between mt-2">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[9px] px-1 py-0 text-sodium border-sodium/30 font-mono">{selectedDb?.label}</Badge>
              <span className="text-[10px] text-cream/45 hidden sm:inline">{t("fullSqlAccess")}</span>
            </div>
            <Button size="sm" className="h-7 text-xs" onClick={handleRunQuery} disabled={!customQuery.trim() || queryMutation.isPending}>
              {queryMutation.isPending ? <Spinner size="xs" className="mr-1" /> : <Play className="h-3 w-3 mr-1" />}
              {t("run")}<span className="ml-1.5 text-[10px] text-cream/60 hidden sm:inline">{"\u2318\u21B5"}</span>
            </Button>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        {queryMutation.error && (
          <div className="m-3 flex items-start gap-2 p-3 rounded-lg bg-terra/10 border border-terra/20">
            <AlertCircle className="h-4 w-4 text-terra shrink-0 mt-0.5" />
            <pre className="text-xs text-terra whitespace-pre-wrap break-all font-mono">{queryMutation.error.message}</pre>
          </div>
        )}
        {queryMutation.data && (
          <>
            <div className="px-3 py-1.5 border-b border-border bg-card/50">
              <span className="text-[10px] text-cream/60">
                {queryMutation.data.command} · {queryMutation.data.rowCount === 1 ? t("rowsCountSingular", { count: queryMutation.data.rowCount }) : t("rowsCountPlural", { count: queryMutation.data.rowCount })}
                {queryMutation.data.category && queryMutation.data.category !== "read" && (
                  <Badge variant="outline" className="ml-2 text-[9px] px-1 py-0 text-sodium border-sodium/30">{queryMutation.data.category}</Badge>
                )}
              </span>
            </div>
            {queryMutation.data.rows.length > 0 ? (
              <>
                {/* Desktop: traditional table */}
                <div className="hidden sm:block">
                  <table className="w-full text-xs border-collapse min-w-[600px]">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-card border-b border-border">
                        {Object.keys(queryMutation.data.rows[0]!).map((key) => <th key={key} className="px-3 py-1.5 text-left font-medium text-cream/60 whitespace-nowrap">{key}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {queryMutation.data.rows.map((row, i) => (
                        <tr key={i} className="border-b border-cream/[0.04] hover:bg-cream/[0.02] transition-colors">
                          {Object.values(row).map((val, j) => (
                            <td key={j} className="px-3 py-1.5 text-cream/75 font-mono whitespace-nowrap max-w-[300px] truncate">
                              {val === null || val === undefined ? <span className="text-cream/35 italic">{t("nullDisplay")}</span> : String(val)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* Mobile: card layout for SQL results */}
                <div className="sm:hidden divide-y divide-cream/[0.04]">
                  {queryMutation.data.rows.map((row, i) => (
                    <div key={i} className="px-3 py-2.5 space-y-1">
                      <span className="text-[9px] text-cream/35">{t("rowLabel", { index: i + 1 })}</span>
                      {Object.entries(row).map(([key, val]) => (
                        <div key={key} className="flex items-start justify-between gap-3">
                          <span className="text-[10px] text-cream/45 font-mono shrink-0">{key}</span>
                          <span className="text-[11px] text-cream/85 font-mono text-right break-all">
                            {val === null || val === undefined ? <span className="text-cream/35 italic">{t("nullDisplay")}</span> : String(val)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="px-3 py-6 text-center text-xs text-cream/45">{t("queryExecutedNoRows")}</div>
            )}
          </>
        )}
        {!queryMutation.data && !queryMutation.error && !queryMutation.isPending && (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="w-12 h-12 rounded-2xl bg-cream/[0.03] border border-cream/[0.06] flex items-center justify-center mx-auto mb-3"><ChevronRight className="h-6 w-6 text-cream/35" /></div>
              <p className="text-xs text-cream/45">{t("writePromptTitle")}</p>
              <p className="text-[10px] text-cream/35 mt-1">{t("writePromptHint")}</p>
            </div>
          </div>
        )}
      </div>

      {/* Destructive SQL confirmation */}
      {pendingDestructiveSql && (
        <Dialog open={!!pendingDestructiveSql} onOpenChange={() => { setPendingDestructiveSql(null); setDestructiveConfirmText(""); }}>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-terra"><AlertCircle className="h-5 w-5" />{t("destructiveTitle")}</DialogTitle>
              <DialogDescription>{t("destructiveDescription")}</DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-terra/20 bg-terra/5 p-3">
              <pre className="text-xs text-terra whitespace-pre-wrap break-all font-mono">{pendingDestructiveSql}</pre>
            </div>
            <div>
              <Label className="text-xs text-cream/75">{t("typeConfirmLabel")}</Label>
              <Input value={destructiveConfirmText} onChange={(e) => setDestructiveConfirmText(e.target.value)} placeholder={t("confirmPlaceholder")} className="mt-1 bg-card/40 text-sm font-mono" />
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => { setPendingDestructiveSql(null); setDestructiveConfirmText(""); }}>{t("cancel")}</Button>
              <Button variant="destructive" disabled={destructiveConfirmText !== "CONFIRM" || queryMutation.isPending} onClick={() => { executeQuery(pendingDestructiveSql); setPendingDestructiveSql(null); setDestructiveConfirmText(""); }}>
                {queryMutation.isPending ? <Spinner size="xs" className="mr-1.5" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}{t("execute")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
