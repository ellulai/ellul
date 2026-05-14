// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  CheckCircle,
  XCircle,
  Copy,
  CheckCheck,
  Shield,
  Terminal,
  FileCode,

  AlertTriangle,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import {
  verifyServerIntegrity,
  formatHash,
  copyToClipboard,
  type VerificationResult,
} from "@/lib/verify-integrity";
import { API_URL } from "@/lib/api";

interface ConfigVerificationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
}

interface ConfigResponse {
  serverId: string;
  cloudInitYaml: string | null;
  cloudInitHash: string | null;
  publicKey: string | null;
  publicKeyFingerprint: string | null;
  createdAt: string;
  verification: {
    instructions: string[];
    command: string;
    note: string;
  };
}

export function ConfigVerificationDialog({
  open,
  onOpenChange,
  serverId,
}: ConfigVerificationDialogProps) {
  const t = useTranslations("console.configVerify");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [copiedHash, setCopiedHash] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [showFullYaml, setShowFullYaml] = useState(false);

  useEffect(() => {
    if (open && serverId) {
      fetchAndVerify();
    }
  }, [open, serverId]);

  const fetchAndVerify = async () => {
    setLoading(true);
    setError(null);
    setVerification(null);

    try {
      const response = await fetch(`${API_URL}/api/servers/${serverId}/config`, {
        credentials: "include",
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
      }

      const data: ConfigResponse = await response.json();
      setConfig(data);

      // Verify if we have the data
      if (data.cloudInitYaml && data.cloudInitHash) {
        const result = await verifyServerIntegrity(
          data.cloudInitYaml,
          data.cloudInitHash
        );
        setVerification(result);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("fetchFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleCopyHash = async () => {
    if (config?.cloudInitHash) {
      await copyToClipboard(config.cloudInitHash);
      setCopiedHash(true);
      setTimeout(() => setCopiedHash(false), 2000);
    }
  };

  const handleCopyCommand = async () => {
    await copyToClipboard("ellul-verify");
    setCopiedCommand(true);
    setTimeout(() => setCopiedCommand(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-cream/65" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>
            {t("subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Spinner size="lg" color="primary" />
              <span className="ml-3 text-cream/60">{t("fetching")}</span>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-terra/20 bg-terra/10 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-terra mt-0.5" />
                <div>
                  <p className="font-medium text-terra">{t("error")}</p>
                  <p className="text-sm text-terra mt-1">{error}</p>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Verification Status */}
              {verification && (
                <div
                  className={`rounded-lg border p-4 ${
                    verification.verified
                      ? "border-sodium/20 bg-sodium/10"
                      : "border-terra/20 bg-terra/10"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {verification.verified ? (
                      <CheckCircle className="h-6 w-6 text-sodium mt-0.5" />
                    ) : (
                      <XCircle className="h-6 w-6 text-terra mt-0.5" />
                    )}
                    <div className="flex-1">
                      <p
                        className={`font-medium ${
                          verification.verified ? "text-sodium" : "text-terra"
                        }`}
                      >
                        {verification.verified
                          ? t("integrityVerified")
                          : t("integrityMismatch")}
                      </p>
                      <p className="text-sm text-cream/60 mt-1">
                        {verification.verified
                          ? t("integrityVerifiedDesc")
                          : t("integrityMismatchDesc")}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Hash Display */}
              {config?.cloudInitHash && (
                <div className="space-y-2">
                  <label className="text-xs text-cream/60 uppercase tracking-wide">
                    {t("configHashLabel")}
                  </label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 bg-secondary rounded-lg font-mono text-sm text-cream/85 break-all">
                      {config.cloudInitHash}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      onClick={handleCopyHash}
                    >
                      {copiedHash ? (
                        <CheckCheck className="h-4 w-4 text-sodium" />
                      ) : (
                        <Copy className="h-4 w-4 text-cream/60" />
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {/* Verification Instructions */}
              <div className="rounded-lg border border-border bg-card/50 p-4 space-y-4">
                <div className="flex items-center gap-2">
                  <Terminal className="h-4 w-4 text-cream/65" />
                  <span className="font-medium text-cream">
                    {t("verifyOnYourServer")}
                  </span>
                </div>

                <p className="text-sm text-cream/60">
                  {t("verifyIntro")}
                </p>

                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-secondary rounded font-mono text-sm text-cream/65">
                    ellul-verify
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={handleCopyCommand}
                  >
                    {copiedCommand ? (
                      <CheckCheck className="h-4 w-4 text-sodium" />
                    ) : (
                      <Copy className="h-4 w-4 text-cream/60" />
                    )}
                  </Button>
                </div>

                <div className="text-xs text-cream/60 space-y-1">
                  <p>{t("scriptIntro")}</p>
                  <ol className="list-decimal list-inside space-y-1 pl-2">
                    <li>{t("scriptStepHash")}</li>
                    <li>{t("scriptStepRootKeys")}</li>
                    <li>{t("scriptStepFirewall")}</li>
                    <li>{t("scriptStepMiner")}</li>
                  </ol>
                </div>
              </div>

              {/* Public Key Fingerprint */}
              {config?.publicKeyFingerprint && (
                <div className="space-y-2">
                  <label className="text-xs text-cream/60 uppercase tracking-wide">
                    {t("publicKeyFingerprintLabel")}
                  </label>
                  <code className="block px-3 py-2 bg-secondary rounded-lg font-mono text-xs text-cream/75 break-all">
                    {config.publicKeyFingerprint}
                  </code>
                  <p
                    className="text-xs text-cream/60"
                    dangerouslySetInnerHTML={{
                      __html: t("publicKeyFingerprintHint"),
                    }}
                  />
                </div>
              )}

              {/* View Full YAML */}
              {config?.cloudInitYaml && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-cream/60 uppercase tracking-wide flex items-center gap-2">
                      <FileCode className="h-3 w-3" />
                      {t("cloudInitLabel")}
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowFullYaml(!showFullYaml)}
                    >
                      {showFullYaml ? t("yamlHide") : t("yamlShow")}
                    </Button>
                  </div>

                  {showFullYaml && (
                    <div className="relative">
                      <pre className="p-4 bg-card rounded-lg text-xs text-cream/75 overflow-auto max-h-[400px] border border-border">
                        {config.cloudInitYaml}
                      </pre>
                      <p className="text-xs text-cream/60 mt-2">
                        {t("yamlNote")}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
