// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback } from "react";
import { Copy, Check, Clock } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { getVpsApiUrl } from "@/lib/domains";

interface ShareLinkDialogProps {
  open: boolean;
  onClose: () => void;
  serverDomain: string;
  project: string;
  noteId: string;
  noteTitle: string;
}

const EXPIRY_OPTIONS = [
  { labelKey: "expiry1h", value: "1h", ms: 60 * 60 * 1000 },
  { labelKey: "expiry24h", value: "24h", ms: 24 * 60 * 60 * 1000 },
  { labelKey: "expiry7d", value: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { labelKey: "expiry30d", value: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { labelKey: "expiryNever", value: "never", ms: 0 },
] as const;

// Share link creation dialog.
export function ShareLinkDialog({
  open,
  onClose,
  serverDomain,
  project,
  noteId,
  noteTitle,
}: ShareLinkDialogProps) {
  const t = useTranslations("console.vault.share");
  const [sharingPolicy, setSharingPolicy] = useState<"internal" | "external">("internal");
  const [expiresIn, setExpiresIn] = useState("24h");
  const [maxUses, setMaxUses] = useState("");
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  const selectedExpiry = EXPIRY_OPTIONS.find((o) => o.value === expiresIn);

  const createLink = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${getVpsApiUrl(serverDomain)}/_auth/vault/share-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          project,
          noteId,
          sharingPolicy,
          maxUses: maxUses ? parseInt(maxUses, 10) : undefined,
          expiresInMs: selectedExpiry?.ms || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || t("createFailed"));
        return;
      }
      const data = await res.json();
      const token = data.link?.token;
      if (token) {
        setCreatedLink(
          `${getVpsApiUrl(serverDomain)}/_auth/vault/share-links/${token}?project=${encodeURIComponent(project)}`,
        );
      }
    } catch (err) {
      console.error("[share-link] Create failed:", err);
    } finally {
      setLoading(false);
    }
  }, [serverDomain, project, noteId, sharingPolicy, selectedExpiry, maxUses, t]);

  const copyToClipboard = useCallback(async () => {
    if (!createdLink) return;
    try {
      await navigator.clipboard.writeText(createdLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }, [createdLink]);

  const handleClose = () => {
    setCreatedLink(null);
    setCopied(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("descriptionPrefix")} <span className="text-cream/85 font-medium">{noteTitle}</span>
          </DialogDescription>
        </DialogHeader>

        {!createdLink ? (
          <div className="space-y-5">
            {/* Sharing policy */}
            <div className="space-y-2">
              <label className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">
                {t("policyLabel")}
              </label>
              <div className="flex gap-2">
                {(["internal", "external"] as const).map((policy) => (
                  <button
                    key={policy}
                    onClick={() => setSharingPolicy(policy)}
                    className={`flex-1 py-2 text-xs rounded-lg border transition-colors ${
                      sharingPolicy === policy
                        ? "border-sodium/30 bg-sodium/10 text-sodium"
                        : "border-cream/[0.08] bg-cream/[0.02] text-cream/60 hover:bg-cream/[0.04] hover:text-cream/75"
                    }`}
                  >
                    {policy === "internal" ? t("policyInternal") : t("policyExternal")}
                  </button>
                ))}
              </div>
            </div>

            {/* Expiry */}
            <div className="space-y-2">
              <label className="text-[11px] font-medium text-cream/60 uppercase tracking-wider flex items-center gap-1.5">
                <Clock className="h-3 w-3" />
                {t("expiresLabel")}
              </label>
              <div className="flex gap-1.5">
                {EXPIRY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setExpiresIn(opt.value)}
                    className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
                      expiresIn === opt.value
                        ? "border-sodium/30 bg-sodium/10 text-sodium"
                        : "border-cream/[0.08] bg-cream/[0.02] text-cream/60 hover:bg-cream/[0.04] hover:text-cream/75"
                    }`}
                  >
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
            </div>

            {/* Max uses */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">
                {t("maxUsesLabel")}
              </label>
              <input
                type="number"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                placeholder={t("maxUsesPlaceholder")}
                min="1"
                className="w-full rounded-md border border-cream/[0.08] bg-transparent px-3 py-1.5 text-sm text-cream/75 placeholder:text-cream/35 focus:outline-none focus:ring-1 focus:ring-sodium/50"
              />
              <p className="text-[10px] text-cream/45">{t("maxUsesHint")}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-3">
              <div className="text-[10px] text-cream/45 mb-1.5">{t("linkCreated")}</div>
              <div className="text-xs font-mono text-cream/75 break-all leading-relaxed">
                {createdLink}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {!createdLink ? (
            <>
              <Button variant="ghost" size="sm" onClick={handleClose}>
                {t("cancel")}
              </Button>
              <Button size="sm" onClick={createLink} loading={loading}>
                {t("createLink")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={handleClose}>
                {t("done")}
              </Button>
              <Button size="sm" onClick={copyToClipboard}>
                {copied ? (
                  <>
                    <Check className="h-3 w-3" />
                    {t("copied")}
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    {t("copyLink")}
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
