// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Lock, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { API_URL } from "@/lib/api";
import { PROVIDER_INFO, type GitProvider } from "./ProviderCard";

interface NormalizedRepo {
  name: string;
  fullName: string;
  url: string;
  sshUrl: string;
  isPrivate: boolean;
  defaultBranch: string;
  description: string | null;
  updatedAt: string;
}

interface CreateRepoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: GitProvider;
  serverId: string;
  onCreated: (repo: NormalizedRepo) => void;
}

export function CreateRepoDialog({
  open,
  onOpenChange,
  provider,
  serverId,
  onCreated,
}: CreateRepoDialogProps) {
  const t = useTranslations("console.git.createRepo");
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);

  const providerInfo = PROVIDER_INFO[provider];

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_URL}/api/git/servers/${serverId}/repos/${provider}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, isPrivate }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(err.message || t("createFailed"));
      }
      return res.json() as Promise<{ repo: NormalizedRepo }>;
    },
    onSuccess: (data) => {
      onCreated(data.repo);
      onOpenChange(false);
      setName("");
    },
  });

  const isValidName = /^[a-zA-Z0-9._-]+$/.test(name) && name.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-[#111] border-border text-cream sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription className="text-cream/60">
            {t("dialogDescription", { provider: providerInfo.name })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label className="text-xs font-medium text-cream/60 mb-1.5 block">
              {t("name")}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              className="bg-cream/[0.03] border-border"
              autoFocus
            />
            {name && !isValidName && (
              <p className="text-xs text-terra mt-1">
                {t("nameValidationError")}
              </p>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-cream/60 mb-1.5 block">
              {t("visibility")}
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setIsPrivate(true)}
                className={`flex-1 flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm transition-all ${
                  isPrivate
                    ? "border-sodium/30 bg-sodium/10 text-sodium"
                    : "border-border bg-secondary/30 text-cream/60 hover:bg-secondary/50"
                }`}
              >
                <Lock className="h-4 w-4" />
                {t("private")}
              </button>
              <button
                onClick={() => setIsPrivate(false)}
                className={`flex-1 flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm transition-all ${
                  !isPrivate
                    ? "border-sodium/30 bg-sodium/10 text-sodium"
                    : "border-border bg-secondary/30 text-cream/60 hover:bg-secondary/50"
                }`}
              >
                <Globe className="h-4 w-4" />
                {t("public")}
              </button>
            </div>
          </div>

          {createMutation.error && (
            <p className="text-xs text-terra">
              {createMutation.error instanceof Error
                ? createMutation.error.message
                : t("createFailed")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-cream/60"
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!isValidName || createMutation.isPending}
            className="bg-sodium hover:bg-sodium text-ink"
          >
            {createMutation.isPending ? (
              <>
                <Spinner size="sm" className="mr-1.5" />
                {t("creating")}
              </>
            ) : (
              t("create")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
