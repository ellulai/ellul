// SPDX-License-Identifier: MIT
"use client";

import { useTranslations } from "next-intl";
import {
  Plus,
  Trash2,
  Check,
  X,
  ChevronDown,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import type { TableInfo } from "./database-types";
import { formatType, PG_TYPES } from "./database-types";

// ── Create Table Dialog ──

interface CreateTableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dbLabel: string | undefined;
  newTableName: string;
  onTableNameChange: (name: string) => void;
  newTableColumns: Array<{ name: string; type: string; nullable: boolean; defaultVal: string }>;
  onColumnsChange: (cols: Array<{ name: string; type: string; nullable: boolean; defaultVal: string }>) => void;
  openTypeDropdown: number | null;
  onTypeDropdownChange: (idx: number | null) => void;
  onSubmit: () => void;
  isPending: boolean;
}

export function CreateTableDialog({
  open, onOpenChange, dbLabel, newTableName, onTableNameChange,
  newTableColumns, onColumnsChange, openTypeDropdown, onTypeDropdownChange,
  onSubmit, isPending,
}: CreateTableDialogProps) {
  const t = useTranslations("console.database.tableDialogs");
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) onTypeDropdownChange(null); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Plus className="h-5 w-5 text-sodium" />{t("createTitle")}</DialogTitle>
          <DialogDescription>
            {t.rich("createDescription", {
              db: dbLabel ?? "",
              strong: (chunks) => <strong className="text-cream/85">{chunks}</strong>,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className={cn("space-y-4 max-h-[60vh] px-1", openTypeDropdown !== null ? "overflow-visible" : "overflow-y-auto")} onClick={() => onTypeDropdownChange(null)}>
          <div>
            <Label className="text-xs text-cream/75">{t("tableName")}</Label>
            <Input value={newTableName} onChange={(e) => onTableNameChange(e.target.value)} placeholder={t("tableNamePlaceholder")} className="mt-1 bg-card/40 text-sm font-mono" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-xs text-cream/75">{t("columnsLabel")}</Label>
              <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => onColumnsChange([...newTableColumns, { name: "", type: "text", nullable: true, defaultVal: "" }])}><Plus className="h-2.5 w-2.5 mr-1" />{t("addColumnButton")}</Button>
            </div>
            <div className="space-y-2">
              {newTableColumns.map((col, i) => (
                <div key={i} className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-2.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input value={col.name} onChange={(e) => { const u = [...newTableColumns]; u[i] = { ...col, name: e.target.value }; onColumnsChange(u); }} placeholder={t("columnNamePlaceholder")} className="h-7 text-xs font-mono bg-transparent flex-1" />
                    <div className="relative" onClick={(e) => e.stopPropagation()}>
                      <button type="button" onClick={() => onTypeDropdownChange(openTypeDropdown === i ? null : i)} className="flex items-center gap-1.5 h-7 rounded-md border border-cream/[0.08] bg-cream/[0.03] hover:bg-cream/[0.06] px-2 transition-colors">
                        <span className="text-xs text-cream/75 font-mono">{col.type}</span>
                        <ChevronDown className={cn("h-2.5 w-2.5 text-cream/45 transition-transform", openTypeDropdown === i && "rotate-180")} />
                      </button>
                      {openTypeDropdown === i && (
                        <div className="absolute top-full right-0 mt-1 w-40 z-50 rounded-lg border border-cream/[0.08] bg-card shadow-2xl backdrop-blur-xl">
                          <div className="p-1 max-h-48 overflow-y-auto">
                            {PG_TYPES.map((pt) => (
                              <button key={pt} type="button" onClick={() => { const u = [...newTableColumns]; u[i] = { ...col, type: pt }; onColumnsChange(u); onTypeDropdownChange(null); }} className={cn("w-full text-left rounded-md px-2.5 py-1.5 text-xs font-mono transition-colors", col.type === pt ? "bg-sodium/10 text-sodium" : "text-cream/75 hover:bg-cream/[0.04]")}>
                                {pt}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    {newTableColumns.length > 1 && <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-cream/45 hover:text-terra" onClick={() => onColumnsChange(newTableColumns.filter((_, j) => j !== i))}><X className="h-3 w-3" /></Button>}
                  </div>
                  <div className="flex items-center gap-3 pl-0.5">
                    <button type="button" onClick={() => { const u = [...newTableColumns]; u[i] = { ...col, nullable: !col.nullable }; onColumnsChange(u); }} className="flex items-center gap-1.5 group">
                      <div className={cn("h-3.5 w-3.5 rounded border flex items-center justify-center transition-colors", col.nullable ? "bg-sodium/80 border-sodium/60" : "border-cream/20 bg-transparent")}>
                        {col.nullable && <Check className="h-2.5 w-2.5 text-cream" />}
                      </div>
                      <span className="text-[10px] text-cream/60 group-hover:text-cream/75 transition-colors">{t("nullable")}</span>
                    </button>
                    <Input value={col.defaultVal} onChange={(e) => { const u = [...newTableColumns]; u[i] = { ...col, defaultVal: e.target.value }; onColumnsChange(u); }} placeholder={t("defaultValuePlaceholder")} className="h-6 text-[10px] font-mono bg-transparent flex-1 border-cream/[0.06]" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={onSubmit} disabled={!newTableName.trim() || !newTableColumns.some(c => c.name.trim()) || isPending}>
            {isPending ? <Spinner size="xs" className="mr-1.5" /> : <Plus className="h-3 w-3 mr-1.5" />}{t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Drop Table Dialog ──

interface DropTableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableName: string | null;
  onConfirm: () => void;
  isPending: boolean;
}

export function DropTableDialog({ open, onOpenChange, tableName, onConfirm, isPending }: DropTableDialogProps) {
  const t = useTranslations("console.database.tableDialogs");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-terra"><AlertCircle className="h-5 w-5" />{t("dropTitle")}</DialogTitle>
          <DialogDescription>
            {t.rich("dropDescription", {
              name: tableName ?? "",
              strong: (chunks) => <strong className="text-cream/85">{chunks}</strong>,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
            {isPending ? <Spinner size="xs" className="mr-1.5" /> : <Trash2 className="h-3.5 w-3.5 mr-1.5" />}{t("dropConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Add Column Dialog ──

interface AddColumnDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableName: string | null;
  colName: string;
  onColNameChange: (v: string) => void;
  colType: string;
  onColTypeChange: (v: string) => void;
  nullable: boolean;
  onNullableChange: (v: boolean) => void;
  defaultVal: string;
  onDefaultChange: (v: string) => void;
  showTypeDropdown: boolean;
  onTypeDropdownChange: (v: boolean) => void;
  onSubmit: () => void;
  isPending: boolean;
}

export function AddColumnDialog({
  open, onOpenChange, tableName, colName, onColNameChange,
  colType, onColTypeChange, nullable, onNullableChange,
  defaultVal, onDefaultChange, showTypeDropdown, onTypeDropdownChange,
  onSubmit, isPending,
}: AddColumnDialogProps) {
  const t = useTranslations("console.database.tableDialogs");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Plus className="h-5 w-5 text-sodium" />{t("addColumnTitle")}</DialogTitle>
          <DialogDescription>
            {t.rich("addColumnDescription", {
              name: tableName ?? "",
              strong: (chunks) => <strong className="text-cream/85">{chunks}</strong>,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div><Label className="text-xs text-cream/75">{t("columnNameLabel")}</Label><Input value={colName} onChange={(e) => onColNameChange(e.target.value)} placeholder={t("columnNameInputPlaceholder")} className="mt-1 bg-card/40 text-sm font-mono" /></div>
          <div><Label className="text-xs text-cream/75">{t("typeLabel")}</Label>
            <div className="relative mt-1">
              <button type="button" onClick={() => onTypeDropdownChange(!showTypeDropdown)} className="flex items-center justify-between w-full h-9 rounded-md border border-cream/[0.08] bg-cream/[0.03] hover:bg-cream/[0.06] px-3 transition-colors">
                <span className="text-sm text-cream/75 font-mono">{colType}</span>
                <ChevronDown className={cn("h-3 w-3 text-cream/45 transition-transform", showTypeDropdown && "rotate-180")} />
              </button>
              {showTypeDropdown && (
                <div className="absolute top-full left-0 mt-1 w-full z-50 rounded-lg border border-cream/[0.08] bg-card shadow-2xl backdrop-blur-xl">
                  <div className="p-1 max-h-48 overflow-y-auto">
                    {PG_TYPES.map((pt) => (
                      <button key={pt} type="button" onClick={() => { onColTypeChange(pt); onTypeDropdownChange(false); }} className={cn("w-full text-left rounded-md px-2.5 py-1.5 text-xs font-mono transition-colors", colType === pt ? "bg-sodium/10 text-sodium" : "text-cream/75 hover:bg-cream/[0.04]")}>
                        {pt}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <button type="button" onClick={() => onNullableChange(!nullable)} className="flex items-center gap-2 group">
            <div className={cn("h-4 w-4 rounded border flex items-center justify-center transition-colors", nullable ? "bg-sodium/80 border-sodium/60" : "border-cream/20 bg-transparent")}>
              {nullable && <Check className="h-3 w-3 text-cream" />}
            </div>
            <span className="text-xs text-cream/75 group-hover:text-cream/85 transition-colors">{t("nullable")}</span>
          </button>
          <div><Label className="text-xs text-cream/75">{t("defaultOptionalLabel")}</Label><Input value={defaultVal} onChange={(e) => onDefaultChange(e.target.value)} placeholder={t("defaultOptionalPlaceholder")} className="mt-1 bg-card/40 text-sm font-mono" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={onSubmit} disabled={!colName.trim() || isPending}>
            {isPending ? <Spinner size="xs" className="mr-1.5" /> : <Plus className="h-3 w-3 mr-1.5" />}{t("addColumn")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Add Row Dialog ──

interface AddRowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableName: string | null;
  tableInfo: TableInfo | undefined;
  rowValues: Record<string, string>;
  onRowValuesChange: (values: Record<string, string>) => void;
  onSubmit: () => void;
  isPending: boolean;
}

export function AddRowDialog({
  open, onOpenChange, tableName, tableInfo,
  rowValues, onRowValuesChange, onSubmit, isPending,
}: AddRowDialogProps) {
  const t = useTranslations("console.database.tableDialogs");
  if (!tableInfo) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Plus className="h-5 w-5 text-sodium" />{t("insertRowTitle")}</DialogTitle>
          <DialogDescription>
            {t.rich("insertRowDescription", {
              name: tableName ?? "",
              strong: (chunks) => <strong className="text-cream/85">{chunks}</strong>,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
          {tableInfo.columns.filter((c) => !c.type.includes("serial")).map((col) => (
            <div key={col.name} className="flex items-center gap-3">
              <div className="w-28 shrink-0"><span className="text-xs font-mono text-cream/75">{col.name}</span><span className="text-[9px] text-cream/45 ml-1">{formatType(col.type)}</span></div>
              <Input value={rowValues[col.name] ?? ""} onChange={(e) => onRowValuesChange({ ...rowValues, [col.name]: e.target.value })} placeholder={col.nullable ? t("nullPlaceholder") : t("requiredPlaceholder")} className="h-7 text-xs font-mono bg-card/40" />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { onOpenChange(false); onRowValuesChange({}); }}>{t("cancel")}</Button>
          <Button onClick={onSubmit} disabled={isPending}>
            {isPending ? <Spinner size="xs" className="mr-1.5" /> : <Plus className="h-3 w-3 mr-1.5" />}{t("insert")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Delete Row Dialog ──

interface DeleteRowDialogProps {
  row: Record<string, string> | null;
  onOpenChange: (row: Record<string, string> | null) => void;
  onConfirm: (row: Record<string, string>) => void;
  isPending: boolean;
}

export function DeleteRowDialog({ row, onOpenChange, onConfirm, isPending }: DeleteRowDialogProps) {
  const t = useTranslations("console.database.tableDialogs");
  if (!row) return null;
  const overflowCount = Object.keys(row).length - 5;
  return (
    <Dialog open={!!row} onOpenChange={() => onOpenChange(null)}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-terra"><AlertCircle className="h-5 w-5" />{t("deleteRowTitle")}</DialogTitle>
          <DialogDescription>{t("deleteRowDescription")}</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-3 max-h-32 overflow-y-auto">
          {Object.entries(row).slice(0, 5).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between text-xs py-0.5">
              <span className="text-cream/60 font-mono">{k}</span>
              <span className="text-cream/75 font-mono truncate max-w-[200px]">{v ?? t("nullPlaceholder")}</span>
            </div>
          ))}
          {overflowCount > 0 && <span className="text-[10px] text-cream/45">{t("moreFields", { count: overflowCount })}</span>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(null)}>{t("cancel")}</Button>
          <Button variant="destructive" onClick={() => onConfirm(row)} disabled={isPending}>
            {isPending ? <Spinner size="xs" className="mr-1.5" /> : <Trash2 className="h-3.5 w-3.5 mr-1.5" />}{t("delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
