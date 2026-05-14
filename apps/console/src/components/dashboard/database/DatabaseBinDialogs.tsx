// SPDX-License-Identifier: MIT
"use client";

import { useTranslations } from "next-intl";
import {
  Trash2,
  ShieldCheck,
  Undo2,
  AlertTriangle,
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
import type { ColumnInfo } from "./database-types";

// ── Recover Confirmation ──

interface RecoverDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCount: number;
  pkColumns: string[] | undefined;
  isPending: boolean;
  onConfirm: () => void;
}

export function RecoverDialog({ open, onOpenChange, selectedCount, pkColumns, isPending, onConfirm }: RecoverDialogProps) {
  const t = useTranslations("console.database.binDialogs");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Undo2 className="h-4 w-4 text-sodium" />
            {selectedCount === 1 ? t("recoverTitleSingular", { count: selectedCount }) : t("recoverTitlePlural", { count: selectedCount })}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t.rich("recoverDescription", {
              code: (chunks) => <code className="text-sodium/80">{chunks}</code>,
            })}
          </DialogDescription>
        </DialogHeader>
        {pkColumns && pkColumns.length > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-sodium/5 border border-sodium/10">
            <ShieldCheck className="h-3 w-3 text-sodium/60 shrink-0" />
            <span className="text-[10px] text-sodium/80">{t("rowsIdentifiedByPk", { columns: pkColumns.join(", ") })}</span>
          </div>
        )}
        <DialogFooter className="flex gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button
            size="sm"
            className="bg-sodium hover:bg-sodium text-ink"
            disabled={isPending}
            onClick={onConfirm}
          >
            {isPending ? <Spinner size="xs" className="mr-1.5" /> : <Undo2 className="h-3 w-3 mr-1.5" />}
            {t("recover")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Purge Confirmation ──

interface PurgeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  purgeAllMode: boolean;
  trashTable: string | null;
  selectedCount: number;
  confirmText: string;
  onConfirmTextChange: (v: string) => void;
  isPending: boolean;
  onConfirm: () => void;
}

export function PurgeDialog({
  open, onOpenChange, purgeAllMode, trashTable, selectedCount,
  confirmText, onConfirmTextChange, isPending, onConfirm,
}: PurgeDialogProps) {
  const t = useTranslations("console.database.binDialogs");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-terra" />
            {t("purgeTitle")}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {purgeAllMode
              ? t.rich("purgeAllDescription", {
                  table: trashTable ?? "",
                  strong: (chunks) => <strong>{chunks}</strong>,
                })
              : selectedCount === 1
                ? t("purgeSelectionDescriptionSingular", { count: selectedCount, table: trashTable ?? "" })
                : t("purgeSelectionDescriptionPlural", { count: selectedCount, table: trashTable ?? "" })
            }
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label className="text-xs text-cream/60">
            {t.rich("typePurgeToConfirm", {
              code: (chunks) => <span className="font-mono text-terra">{chunks}</span>,
            })}
          </Label>
          <Input
            value={confirmText}
            onChange={(e) => onConfirmTextChange(e.target.value)}
            placeholder={t("purgePlaceholder")}
            className="h-8 text-xs font-mono"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && confirmText === "purge") onConfirm();
            }}
          />
        </div>
        <DialogFooter className="flex gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={confirmText !== "purge" || isPending}
            onClick={onConfirm}
          >
            {isPending ? <Spinner size="xs" className="mr-1.5" /> : <Trash2 className="h-3 w-3 mr-1.5" />}
            {t("purgeForever")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
