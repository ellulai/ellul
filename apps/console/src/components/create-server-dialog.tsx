// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { Rocket, AlertCircle, Zap, Terminal } from "lucide-react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";

interface CreateServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: "cloud_platform" | "shield_proxy";
  plan?: "free" | "hobby" | "pro";
  onSuccess?: () => void;
}

export function CreateServerDialog({
  open,
  onOpenChange,
  product = "cloud_platform",
  plan = "free",
  onSuccess,
}: CreateServerDialogProps) {
  const queryClient = useQueryClient();
  const t = useTranslations("console.createServer");
  const [error, setError] = useState<string | null>(null);

  // Reset state when dialog closes
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setError(null);
    }
    onOpenChange(open);
  };

  // Create server mutation
  const createServerMutation = useMutation({
    mutationFn: async () => {
      const response = await api.api.servers.$post({
        json: {
          product,
          plan,
        },
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          (errorData as { error?: string }).error || "Failed to create server"
        );
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
      handleOpenChange(false);
      onSuccess?.();
    },
  });

  const handleDeploy = () => {
    setError(null);
    createServerMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-5 w-5 text-primary" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Mode Indicator */}
          <div className="rounded-lg p-4 border bg-sodium dark:bg-ink-2/20 border-sodium dark:border-sodium">
            <div className="flex items-start gap-3">
              <Zap className="h-5 w-5 text-cream/65 dark:text-cream/65 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-cream/65 dark:text-cream/65">
                  {t("terminalAccessTitle")}
                </p>
                <p className="text-sm mt-1 text-cream/65 dark:text-cream/65">
                  {t("terminalAccessDescription")}
                </p>
              </div>
            </div>
          </div>

          {/* Sandbox warning for standard */}
          {plan === "free" && (
            <div className="rounded-lg p-3 border bg-sodium/[0.08] dark:bg-sodium/[0.06] border-sodium dark:border-sodium">
              <p className="text-xs text-sodium dark:text-sodium">
                {t("sandboxWarning")}
              </p>
            </div>
          )}

          {/* What you get */}
          <div className="space-y-2">
            <p className="text-sm font-medium">
              {t("planIncludes", { plan: plan === "free" ? "Free" : "Pro" })}
            </p>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li className="flex items-center gap-2">
                <Terminal className="h-3 w-3" />
                {plan === "free"
                  ? t("oneWorkspace")
                  : t("twoWorkspaces")}
              </li>
              <li className="flex items-center gap-2">
                <Terminal className="h-3 w-3" />
                {t("nodejs")}
              </li>
              <li className="flex items-center gap-2">
                <Terminal className="h-3 w-3" />
                {t("opencode")}
              </li>
              <li className="flex items-center gap-2">
                <Terminal className="h-3 w-3" />
                {t("https")}
              </li>
              {plan !== "free" && (
                <li className="flex items-center gap-2">
                  <Terminal className="h-3 w-3" />
                  {t("upgradeable")}
                </li>
              )}
            </ul>
          </div>

          <p className="text-xs text-muted-foreground">
            {t.rich("afterDeployNote", {
              code: (chunks) => <code className="bg-muted px-1 rounded">{chunks}</code>,
            })}
          </p>
        </div>

        {/* Error Message */}
        {(error || createServerMutation.error) && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
            <p className="text-sm text-destructive flex items-center gap-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {error || createServerMutation.error?.message}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            onClick={handleDeploy}
            disabled={createServerMutation.isPending}
          >
            {createServerMutation.isPending ? (
              <>
                <Spinner size="sm" className="mr-2" />
                {t("deploying")}
              </>
            ) : (
              <>
                <Rocket className="h-4 w-4 mr-2" />
                {t("title")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
