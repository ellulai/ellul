// SPDX-License-Identifier: MIT
"use client";

import React, { useCallback, useRef, useState, useEffect } from "react";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ColumnInfo, ColumnFilter, FilterOp } from "./database-types";
import { getTypeIcon, formatType, FILTER_OPS, PAGE_SIZE } from "./database-types";

export interface MobileTablesProps {
  columns: ColumnInfo[];
  dataRows: Record<string, string>[];
  isLoadingData: boolean;
  isFetchingData: boolean;
  selectedTable: string | null;
  selectedTableInfo: { columns: ColumnInfo[]; rowCount: number } | undefined;
  sortColumn: string | null;
  sortDir: "ASC" | "DESC";
  columnFilters: Record<string, ColumnFilter>;
  activeFilterCount: number;
  dataPage: number;
  totalPages: number;
  editingCell: { rowIndex: number; column: string } | null;
  editingValue: string;
  filterPopover: string | null;
  filterDraftOp: FilterOp;
  filterDraftValue: string;
  onSort: (col: string) => void;
  onSetDataPage: (fn: (p: number) => number) => void;
  onSetMobileView: (view: "overview" | "detail" | "structure" | "table") => void;
  onStartEdit: (rowIndex: number, column: string, currentValue: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onSetEditingValue: (v: string) => void;
  onCopyCSV: () => void;
  onShowAddRow: () => void;
  onShowAddColumn: () => void;
  onShowDropTable: () => void;
  onShowDeleteRow: (row: Record<string, string>) => void;
  onClearAllFilters: () => void;
  onClearFilter: (col: string) => void;
  onApplyFilterWithNav: (col: string) => void;
  onSetFilterPopover: (col: string | null) => void;
  onSetFilterDraftOp: (op: FilterOp) => void;
  onSetFilterDraftValue: (v: string) => void;
  editInputRef: React.RefObject<HTMLInputElement | null>;
}

// Mobile overview: column grid
export function MobileOverview(props: MobileTablesProps & { mobileColIndex: number; onZoomIn: (idx: number) => void }) {
  const t = useTranslations("console.database.tables");
  const { columns, dataRows, isLoadingData, isFetchingData, sortColumn, sortDir, columnFilters, activeFilterCount, dataPage, totalPages, onSetDataPage, onCopyCSV, onShowAddRow, onSetMobileView, onZoomIn } = props;

  if (isLoadingData) return <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  if (columns.length === 0) return <div className="flex-1 flex items-center justify-center"><p className="text-xs text-cream/45">{t("noColumns")}</p></div>;

  return (
    <>
      <div className="flex-1 overflow-y-auto min-h-0 relative">
        {isFetchingData && <div className="absolute top-2 right-2 z-10"><Spinner size="xs" /></div>}
        {columns.length >= 10 ? (
          <div className="p-3 grid grid-cols-2 gap-2">
            {columns.map((col, ci) => {
              const Icon = getTypeIcon(col.type);
              const hasFilter = !!columnFilters[col.name];
              return (
                <button key={col.name} type="button" onClick={() => onZoomIn(ci)} className={cn("rounded-lg border p-2.5 text-left transition-all active:scale-[0.98]", hasFilter ? "border-sodium/30 bg-sodium/5" : "border-cream/[0.08] bg-cream/[0.02] hover:bg-cream/[0.04]")}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Icon className="h-3 w-3 text-cream/45 shrink-0" />
                    <span className="text-[11px] font-medium text-cream/85 font-mono truncate">{col.name}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] text-cream/45 font-mono">{formatType(col.type)}</span>
                    <div className="flex items-center gap-1">
                      {hasFilter && <span className="w-1.5 h-1.5 rounded-full bg-sodium" />}
                      {sortColumn === col.name && <ArrowUp className="h-2 w-2 text-sodium" />}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="p-3 space-y-2">
            {columns.map((col, ci) => {
              const Icon = getTypeIcon(col.type);
              const hasFilter = !!columnFilters[col.name];
              const preview = dataRows.slice(0, 3).map((row) => { const v = row[col.name]; return v === null || v === undefined ? "NULL" : String(v); });
              return (
                <button key={col.name} type="button" onClick={() => onZoomIn(ci)} className={cn("w-full rounded-xl border p-3 text-left transition-all active:scale-[0.98]", hasFilter ? "border-sodium/30 bg-sodium/5" : "border-cream/[0.08] bg-cream/[0.02] hover:bg-cream/[0.04]")}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Icon className="h-3.5 w-3.5 text-cream/60" />
                      <span className="text-xs font-medium text-cream/85 font-mono">{col.name}</span>
                      <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono">{formatType(col.type)}</Badge>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {hasFilter && <span className="w-1.5 h-1.5 rounded-full bg-sodium" />}
                      {sortColumn === col.name && (sortDir === "ASC" ? <ArrowUp className="h-2.5 w-2.5 text-sodium" /> : <ArrowDown className="h-2.5 w-2.5 text-sodium" />)}
                      <ChevronRight className="h-3.5 w-3.5 text-cream/35" />
                    </div>
                  </div>
                  {preview.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {preview.map((v, pi) => <span key={pi} className={cn("text-[10px] font-mono px-1.5 py-0.5 rounded-md truncate max-w-[120px]", v === "NULL" ? "text-cream/35 italic bg-cream/[0.02]" : "text-cream/60 bg-cream/[0.03]")}>{v}</span>)}
                      {dataRows.length > 3 && <span className="text-[10px] text-cream/35 px-1.5 py-0.5">+{dataRows.length - 3}</span>}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border bg-card">
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 text-[10px] px-2 text-cream/60" onClick={onShowAddRow}><Plus className="h-3 w-3 mr-1" />{t("rowAction")}</Button>
            <Button variant="ghost" size="sm" className="h-7 text-[10px] px-2 text-cream/60" onClick={onCopyCSV} disabled={!dataRows.length}><Copy className="h-3 w-3 mr-1" />{t("csvAction")}</Button>
            <Button variant="ghost" size="sm" className="h-7 text-[10px] px-2 text-cream/60" onClick={() => onSetMobileView("structure")}><Table2 className="h-3 w-3 mr-1" />{t("schemaAction")}</Button>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={dataPage === 0} onClick={() => onSetDataPage((p) => p - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
            <span className="text-[10px] text-cream/60 tabular-nums min-w-[2rem] text-center">{dataPage + 1}</span>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={dataPage >= totalPages - 1} onClick={() => onSetDataPage((p) => p + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
      </div>
    </>
  );
}

// Mobile detail: single column zoomed-in
export function MobileDetail(props: MobileTablesProps & {
  mobileColIndex: number;
  onSetMobileColIndex: (fn: (i: number) => number) => void;
  onZoomOut: () => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  mobileContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useTranslations("console.database.tables");
  const {
    columns, dataRows, isLoadingData, selectedTable, sortColumn, sortDir, columnFilters,
    activeFilterCount, dataPage, totalPages, editingCell, editingValue,
    filterPopover, filterDraftOp, filterDraftValue,
    onSort, onSetDataPage, onSetMobileView, onStartEdit, onSaveEdit, onCancelEdit, onSetEditingValue,
    onCopyCSV, onShowAddRow, onShowDeleteRow, onClearFilter, onApplyFilterWithNav,
    onSetFilterPopover, onSetFilterDraftOp, onSetFilterDraftValue, editInputRef,
    mobileColIndex, onSetMobileColIndex, onZoomOut, onTouchStart, onTouchEnd, mobileContainerRef,
  } = props;

  if (isLoadingData) return <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>;
  if (columns.length === 0) return <div className="flex-1 flex items-center justify-center"><p className="text-xs text-cream/45">{t("noColumns")}</p></div>;

  return (
    <>
      <div className="shrink-0 flex items-center border-b border-border bg-card">
        <button type="button" onClick={onZoomOut} className="shrink-0 flex items-center justify-center w-10 h-10 text-cream/60 active:bg-cream/[0.06] transition-colors" title={t("zoomOut")}><ChevronsLeft className="h-4 w-4" /></button>
        <button type="button" disabled={mobileColIndex === 0} onClick={() => onSetMobileColIndex((i) => i - 1)} className={cn("shrink-0 flex items-center justify-center w-8 h-10 transition-colors", mobileColIndex === 0 ? "text-cream/85" : "text-cream/60 active:bg-cream/[0.06]")}><ChevronLeft className="h-3.5 w-3.5" /></button>
        <div className="flex-1 text-center min-w-0">
          <button type="button" onClick={() => onSort(columns[mobileColIndex]!.name)} className="inline-flex items-center gap-1.5 px-2 py-2">
            <span className="text-xs font-medium text-cream/85 font-mono truncate">{columns[mobileColIndex]?.name}</span>
            <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono shrink-0">{formatType(columns[mobileColIndex]?.type ?? "")}</Badge>
            {sortColumn === columns[mobileColIndex]?.name && (sortDir === "ASC" ? <ArrowUp className="h-2.5 w-2.5 text-sodium" /> : <ArrowDown className="h-2.5 w-2.5 text-sodium" />)}
          </button>
          <div className="flex items-center justify-center gap-1.5 pb-1.5">
            <button type="button" onClick={() => { const col = columns[mobileColIndex]!.name; if (filterPopover === col) { onSetFilterPopover(null); } else { onSetFilterPopover(col); onSetFilterDraftOp(columnFilters[col]?.op ?? "contains"); onSetFilterDraftValue(columnFilters[col]?.value ?? ""); } }} className={cn("inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border transition-colors", columnFilters[columns[mobileColIndex]?.name ?? ""] ? "border-sodium/30 text-sodium bg-sodium/10" : "border-cream/[0.08] text-cream/45 hover:text-cream/75")}><Filter className="h-2.5 w-2.5" />{columnFilters[columns[mobileColIndex]?.name ?? ""] ? t("filtered") : t("filter")}</button>
            {columnFilters[columns[mobileColIndex]?.name ?? ""] && <button type="button" onClick={() => onClearFilter(columns[mobileColIndex]!.name)} className="text-[10px] text-cream/45 hover:text-cream/75"><X className="h-3 w-3" /></button>}
          </div>
        </div>
        <button type="button" disabled={mobileColIndex >= columns.length - 1} onClick={() => onSetMobileColIndex((i) => i + 1)} className={cn("shrink-0 flex items-center justify-center w-8 h-10 transition-colors", mobileColIndex >= columns.length - 1 ? "text-cream/85" : "text-cream/60 active:bg-cream/[0.06]")}><ChevronRight className="h-3.5 w-3.5" /></button>
      </div>

      {filterPopover && filterPopover === columns[mobileColIndex]?.name && (
        <div className="shrink-0 border-b border-cream/[0.06] bg-card/90 backdrop-blur-sm px-3 py-2.5 space-y-2">
          <select value={filterDraftOp} onChange={(e) => onSetFilterDraftOp(e.target.value as FilterOp)} className="w-full h-8 text-xs bg-card/40 border border-input rounded-md px-2 text-cream/75">{FILTER_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          {FILTER_OPS.find((o) => o.value === filterDraftOp)?.needsValue !== false && <input type="text" value={filterDraftValue} onChange={(e) => onSetFilterDraftValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onApplyFilterWithNav(columns[mobileColIndex]!.name); }} placeholder={t("filterValuePlaceholder")} autoFocus className="w-full h-8 text-xs bg-card/40 border border-input rounded-md px-2 text-cream/75 placeholder:text-cream/45 focus:outline-none focus:ring-1 focus:ring-sodium/50" />}
          <div className="flex items-center gap-1.5"><Button size="sm" className="h-7 text-xs flex-1" onClick={() => onApplyFilterWithNav(columns[mobileColIndex]!.name)}>{t("applyFilter")}</Button><Button variant="ghost" size="sm" className="h-7 text-xs text-cream/60" onClick={() => onSetFilterPopover(null)}>{t("cancelFilter")}</Button></div>
        </div>
      )}

      <div className="shrink-0 flex items-center justify-center gap-1 py-1.5 bg-card/50">
        {columns.map((col, i) => <button key={col.name} type="button" onClick={() => onSetMobileColIndex(() => i)} className={cn("transition-all rounded-full", i === mobileColIndex ? "w-4 h-1.5 bg-sodium" : columnFilters[col.name] ? "w-1.5 h-1.5 bg-sodium/50" : "w-1.5 h-1.5 bg-ink-1 hover:bg-ink-1")} title={col.name} />)}
      </div>

      <div ref={mobileContainerRef} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} className="flex-1 overflow-y-auto min-h-0">
        {dataRows.length === 0 ? (
          <div className="py-8 text-center text-xs text-cream/45">{activeFilterCount > 0 ? t("noMatchingRows") : t("emptyTable")}</div>
        ) : (
          <div className="divide-y divide-cream/[0.04]">
            {dataRows.map((row, i) => {
              const col = columns[mobileColIndex]; if (!col) return null;
              const val = row[col.name];
              const isEditing = editingCell?.rowIndex === i && editingCell?.column === col.name;
              return (
                <div key={i} className="flex items-center gap-0 group/mrow">
                  <div className="shrink-0 w-10 text-center text-[10px] text-cream/35 tabular-nums py-2.5 select-none">{dataPage * PAGE_SIZE + i + 1}</div>
                  <div className="flex-1 min-w-0 px-3 py-2.5" onClick={() => { if (!isEditing) onStartEdit(i, col.name, val ?? ""); }}>
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <input ref={editInputRef} type="text" value={editingValue} onChange={(e) => onSetEditingValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onSaveEdit(); if (e.key === "Escape") onCancelEdit(); }} className="flex-1 h-8 text-sm font-mono bg-card/40 border border-sodium/50 rounded px-2 text-cream/85 focus:outline-none focus:ring-1 focus:ring-sodium/50" />
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-sodium" onClick={onSaveEdit}><Check className="h-3 w-3" /></Button>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-cream/60" onClick={onCancelEdit}><X className="h-3 w-3" /></Button>
                      </div>
                    ) : val === null || val === undefined ? (<span className="text-sm text-cream/35 italic">{t("nullDisplay")}</span>) : (<span className="text-sm text-cream/85 font-mono break-all line-clamp-3">{String(val)}</span>)}
                  </div>
                  <div className="shrink-0 opacity-0 group-hover/mrow:opacity-100 pr-2"><button type="button" className="h-6 w-6 p-0 flex items-center justify-center text-cream/35 hover:text-terra" onClick={() => onShowDeleteRow(row)}><Trash2 className="h-3 w-3" /></button></div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-card">
        <div className="flex items-center justify-between px-3 py-2">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 text-[10px] px-2 text-cream/60" onClick={onShowAddRow}><Plus className="h-3 w-3 mr-1" />{t("rowAction")}</Button>
            <Button variant="ghost" size="sm" className="h-7 text-[10px] px-2 text-cream/60" onClick={onCopyCSV} disabled={!dataRows.length}><Copy className="h-3 w-3 mr-1" />{t("csvAction")}</Button>
            <Button variant="ghost" size="sm" className="h-7 text-[10px] px-2 text-cream/60" onClick={() => onSetMobileView("structure")}><Table2 className="h-3 w-3 mr-1" />{t("schemaAction")}</Button>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={dataPage === 0} onClick={() => onSetDataPage((p) => p - 1)}><ChevronLeft className="h-3.5 w-3.5" /></Button>
            <span className="text-[10px] text-cream/60 tabular-nums min-w-[2rem] text-center">{dataPage + 1}</span>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={dataPage >= totalPages - 1} onClick={() => onSetDataPage((p) => p + 1)}><ChevronRight className="h-3.5 w-3.5" /></Button>
          </div>
        </div>
      </div>
    </>
  );
}

// Mobile structure view
export function MobileStructure(props: {
  selectedTable: string | null;
  selectedTableInfo: { columns: ColumnInfo[]; rowCount: number } | undefined;
  onBack: () => void;
  onShowAddColumn: () => void;
  onShowDropTable: () => void;
}) {
  const t = useTranslations("console.database.tables");
  const { selectedTable, selectedTableInfo, onBack, onShowAddColumn, onShowDropTable } = props;
  if (!selectedTableInfo) return null;
  return (
    <>
      <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-border bg-card">
        <button type="button" onClick={onBack} className="text-cream/60 active:bg-cream/[0.06] rounded-md p-1 transition-colors"><ChevronLeft className="h-4 w-4" /></button>
        <div className="flex-1 min-w-0">
          <span className="text-xs font-medium text-cream/85 font-mono">{selectedTable}</span>
          <span className="text-[10px] text-cream/45 ml-2">{t("columnsCount", { columns: selectedTableInfo.columns.length, rows: selectedTableInfo.rowCount })}</span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-1.5">
        {selectedTableInfo.columns.map((col) => {
          const Icon = getTypeIcon(col.type);
          return (
            <div key={col.name} className="flex items-center justify-between rounded-lg border border-cream/[0.06] bg-cream/[0.02] px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5 text-cream/60" />
                <span className="text-xs font-medium text-cream/85 font-mono">{col.name}</span>
                <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono">{formatType(col.type)}</Badge>
              </div>
              <div className="flex items-center gap-2">
                {!col.nullable && <span className="text-[9px] text-sodium/70">NOT NULL</span>}
                {col.default && <span className="text-[9px] text-cream/45 font-mono truncate max-w-[100px]">= {col.default}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="shrink-0 border-t border-border bg-card">
        <div className="flex items-center gap-1 px-3 py-2">
          <Button variant="ghost" size="sm" className="h-7 text-[10px] px-2 text-cream/60 hover:text-sodium" onClick={onShowAddColumn}><Plus className="h-3 w-3 mr-1" />{t("addColumn")}</Button>
          <Button variant="ghost" size="sm" className="h-7 text-[10px] px-2 text-cream/60 hover:text-terra" onClick={onShowDropTable}><Trash2 className="h-3 w-3 mr-1" />{t("dropTable")}</Button>
        </div>
      </div>
    </>
  );
}
