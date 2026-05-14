// SPDX-License-Identifier: MIT
"use client";

import { useTranslations } from "next-intl";
import {
  Table2,
  Trash2,
  X,
  ArrowUp,
  ArrowDown,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ColumnInfo } from "./database-types";

interface DatabaseBinContentProps {
  trashTable: string | null;
  trashRows: Record<string, string>[];
  trashTableColumns: ColumnInfo[];
  trashPkColumns: string[] | undefined;
  trashTotalCount: number | undefined;
  trashTotalPages: number;
  trashPage: number;
  trashSearch: string;
  trashSortDir: "DESC" | "ASC";
  trashSelected: Set<string>;
  isLoadingTrashData: boolean;
  isMutating: boolean;
  trashRowKey: (row: Record<string, string>) => string;
  onSetTrashPage: (fn: (p: number) => number) => void;
  onSetTrashSortDir: (fn: (d: "DESC" | "ASC") => "DESC" | "ASC") => void;
  onTrashSelectAll: () => void;
  onTrashToggleRow: (row: Record<string, string>) => void;
  onRecoverSingle: (row: Record<string, string>) => void;
  onPurgeSingle: (row: Record<string, string>) => void;
  onClearSearch: () => void;
}

export function DatabaseBinContent({
  trashTable, trashRows, trashTableColumns, trashPkColumns,
  trashTotalCount, trashTotalPages, trashPage, trashSearch, trashSortDir,
  trashSelected, isLoadingTrashData, isMutating,
  trashRowKey, onSetTrashPage, onSetTrashSortDir,
  onTrashSelectAll, onTrashToggleRow, onRecoverSingle, onPurgeSingle, onClearSearch,
}: DatabaseBinContentProps) {
  const t = useTranslations("console.database.bin");
  if (!trashTable) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <Trash2 className="h-8 w-8 text-cream/35 mb-3" />
        <p className="text-xs text-cream/60">{t("selectTableToView")}</p>
        <p className="text-[10px] text-cream/45 mt-1 text-center max-w-[280px]">
          {t("selectTableHint")}
        </p>
      </div>
    );
  }

  if (isLoadingTrashData) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-2 text-xs text-cream/60">
          <Spinner size="sm" />
          {t("loading")}
        </div>
      </div>
    );
  }

  if (trashRows.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <CheckCircle2 className="h-8 w-8 text-sodium/30 mb-3" />
        <p className="text-xs text-cream/60">
          {trashSearch ? t("noMatchingDeleted", { query: trashSearch }) : t("noDeletedRows", { table: trashTable })}
        </p>
        <p className="text-[10px] text-cream/45 mt-1">
          {trashSearch ? t("tryDifferentSearch") : t("rowsAppearHere")}
        </p>
        {trashSearch && (
          <Button variant="ghost" size="sm" className="mt-3 text-[10px] text-sodium" onClick={onClearSearch}>
            {t("clearSearch")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      {/* Desktop table */}
      <div className="hidden sm:block flex-1 overflow-auto min-h-0">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-[#0d0d1a]">
            <tr className="border-b border-border">
              <th className="w-8 px-2 py-2 text-left">
                <input type="checkbox" checked={trashSelected.size === trashRows.length && trashRows.length > 0} onChange={onTrashSelectAll} className="rounded border-cream/20 bg-cream/5 text-sodium focus:ring-sodium/30 h-3.5 w-3.5" />
              </th>
              <th className="w-10 px-1 py-2" />
              <th className="px-3 py-2 text-left font-medium text-sodium/80 whitespace-nowrap">
                <button type="button" className="flex items-center gap-1 hover:text-sodium transition-colors" onClick={() => { onSetTrashSortDir((d) => d === "DESC" ? "ASC" : "DESC"); onSetTrashPage(() => 0); }}>
                  deleted_at
                  {trashSortDir === "DESC" ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />}
                </button>
              </th>
              <th className="px-3 py-2 text-left font-medium text-sodium/80 whitespace-nowrap">deleted_by</th>
              {trashTableColumns
                .filter((c) => c.name !== "deleted_at" && c.name !== "deleted_by")
                .map((col) => {
                  const isPk = trashPkColumns?.includes(col.name);
                  return (
                    <th key={col.name} className="px-3 py-2 text-left font-medium text-cream/60 whitespace-nowrap font-mono">
                      <span className="flex items-center gap-1">
                        {col.name}
                        {isPk && (
                          <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild>
                            <span className="text-[8px] text-sodium/50 font-sans font-bold">PK</span>
                          </TooltipTrigger><TooltipContent>{t("primaryKeyTooltip")}</TooltipContent></Tooltip></TooltipProvider>
                        )}
                      </span>
                    </th>
                  );
                })}
            </tr>
          </thead>
          <tbody>
            {trashRows.map((row) => {
              const key = trashRowKey(row);
              const isSelected = trashSelected.has(key);
              return (
                <tr key={key} className={cn("border-b border-cream/[0.03] group transition-colors", isSelected ? "bg-sodium/5" : "hover:bg-cream/[0.02]")}>
                  <td className="w-8 px-2 py-1.5">
                    <input type="checkbox" checked={isSelected} onChange={() => onTrashToggleRow(row)} className="rounded border-cream/20 bg-cream/5 text-sodium focus:ring-sodium/30 h-3.5 w-3.5" />
                  </td>
                  <td className="w-10 px-1 py-1.5">
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <TooltipProvider delayDuration={100}><Tooltip><TooltipTrigger asChild>
                        <button type="button" disabled={isMutating} onClick={(e) => { e.stopPropagation(); onRecoverSingle(row); }} className="h-5 w-5 flex items-center justify-center rounded text-sodium/70 hover:text-sodium hover:bg-sodium/10 disabled:opacity-30 transition-colors"><Undo2 className="h-3 w-3" /></button>
                      </TooltipTrigger><TooltipContent side="top">{t("recoverThisRow")}</TooltipContent></Tooltip></TooltipProvider>
                      <TooltipProvider delayDuration={100}><Tooltip><TooltipTrigger asChild>
                        <button type="button" disabled={isMutating} onClick={(e) => { e.stopPropagation(); onPurgeSingle(row); }} className="h-5 w-5 flex items-center justify-center rounded text-terra/70 hover:text-terra hover:bg-terra/10 disabled:opacity-30 transition-colors"><X className="h-3 w-3" /></button>
                      </TooltipTrigger><TooltipContent side="top">{t("permanentlyDelete")}</TooltipContent></Tooltip></TooltipProvider>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-terra/80 whitespace-nowrap font-mono text-[10px]">{row.deleted_at ? new Date(row.deleted_at).toLocaleString() : ""}</td>
                  <td className="px-3 py-1.5 text-cream/60 whitespace-nowrap text-[10px]">{row.deleted_by ?? ""}</td>
                  {trashTableColumns.filter((c) => c.name !== "deleted_at" && c.name !== "deleted_by").map((col) => (
                    <td key={col.name} className="px-3 py-1.5 text-cream/75 whitespace-nowrap font-mono max-w-[200px] truncate">
                      {row[col.name] === null || row[col.name] === undefined ? <span className="text-cream/35 italic">{t("nullDisplay")}</span> : String(row[col.name]).slice(0, 100)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: card view */}
      <div className="sm:hidden flex-1 overflow-y-auto p-3 space-y-2">
        {trashRows.map((row) => {
          const key = trashRowKey(row);
          const isSelected = trashSelected.has(key);
          const visibleCols = trashTableColumns.filter((c) => c.name !== "deleted_at" && c.name !== "deleted_by");
          const previewCols = visibleCols.slice(0, 3);
          return (
            <div key={key} className={cn("rounded-lg border p-3 transition-colors", isSelected ? "border-sodium/30 bg-sodium/5" : "border-cream/[0.06] bg-cream/[0.02]")}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2" onClick={() => onTrashToggleRow(row)}>
                  <input type="checkbox" checked={isSelected} readOnly className="rounded border-cream/20 bg-cream/5 text-sodium focus:ring-sodium/30 h-3.5 w-3.5" />
                  <span className="text-[10px] text-terra/80 font-mono">{row.deleted_at ? new Date(row.deleted_at).toLocaleString() : t("deleted")}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" disabled={isMutating} onClick={() => onRecoverSingle(row)} className="h-7 w-7 flex items-center justify-center rounded-md text-sodium/70 hover:text-sodium hover:bg-sodium/10 disabled:opacity-30 transition-colors"><Undo2 className="h-3.5 w-3.5" /></button>
                  <button type="button" disabled={isMutating} onClick={() => onPurgeSingle(row)} className="h-7 w-7 flex items-center justify-center rounded-md text-terra/70 hover:text-terra hover:bg-terra/10 disabled:opacity-30 transition-colors"><X className="h-3.5 w-3.5" /></button>
                </div>
              </div>
              {row.deleted_by && <div className="text-[10px] text-cream/45 mb-1.5">{row.deleted_by}</div>}
              <div className="space-y-1">
                {previewCols.map((col) => (
                  <div key={col.name} className="flex items-center gap-2 text-[10px]">
                    <span className="text-cream/45 shrink-0 w-20 truncate">{col.name}</span>
                    <span className="text-cream/75 font-mono truncate flex-1">
                      {row[col.name] === null || row[col.name] === undefined ? <span className="text-cream/35 italic">{t("nullDisplay")}</span> : String(row[col.name]).slice(0, 60)}
                    </span>
                  </div>
                ))}
                {visibleCols.length > 3 && <span className="text-[10px] text-cream/35">{t("moreColumns", { count: visibleCols.length - 3 })}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination + info footer */}
      <div className="shrink-0 border-t border-border px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-cream/45 tabular-nums">
            {(trashTotalCount ?? 0) === 1 ? t("deletedRowsCountSingular", { count: trashTotalCount ?? 0 }) : t("deletedRowsCountPlural", { count: trashTotalCount ?? 0 })}
            {trashSearch && t("matchingQuery", { query: trashSearch })}
          </span>
          {!trashPkColumns?.length && trashRows.length > 0 && (
            <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild>
              <div className="flex items-center gap-0.5 text-sodium/50">
                <AlertTriangle className="h-2.5 w-2.5" />
                <span className="text-[9px]">{t("noPk")}</span>
              </div>
            </TooltipTrigger><TooltipContent className="max-w-[240px] text-xs">{t("noPkTooltip")}</TooltipContent></Tooltip></TooltipProvider>
          )}
        </div>
        {trashTotalPages > 1 && (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => onSetTrashPage(() => 0)} disabled={trashPage === 0}><ChevronsLeft className="h-3 w-3" /></Button>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => onSetTrashPage((p) => Math.max(0, p - 1))} disabled={trashPage === 0}><ChevronLeft className="h-3 w-3" /></Button>
            <span className="text-[10px] text-cream/60 px-2 tabular-nums">{trashPage + 1} / {trashTotalPages}</span>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => onSetTrashPage((p) => Math.min(trashTotalPages - 1, p + 1))} disabled={trashPage >= trashTotalPages - 1}><ChevronRight className="h-3 w-3" /></Button>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => onSetTrashPage(() => trashTotalPages - 1)} disabled={trashPage >= trashTotalPages - 1}><ChevronsRight className="h-3 w-3" /></Button>
          </div>
        )}
      </div>
    </>
  );
}
