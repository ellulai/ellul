// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
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
import {
  AlertCircle,
  CheckCircle,
  Copy,
  CheckCheck,
  Terminal,
  Cpu,
  MemoryStick,
  HardDrive,
  Monitor,
  Shield,
} from "lucide-react";
import { api } from "@/lib/api";
import { EllulLogo } from "@ellul.ai/ui/ellul-logo";

interface ByosEnrollDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type EnrollmentPhase = "generate" | "waiting" | "detected" | "installing" | "ready";

interface EnrollmentData {
  enrollmentId: string;
  token: string;
  expiresAt: string;
  installCommand: string;
}

interface ServerInfo {
  os: string;
  arch: string;
  ram_mb: number;
  cpu_cores: number;
  disk_gb: number;
  hostname: string;
  platform: "linux" | "macos";
}

interface StatusResponse {
  enrollment: {
    id: string;
    status: "pending" | "expired" | "ready" | "installing";
    expiresAt?: string;
    serverId?: string;
    serverInfo?: ServerInfo;
    registrationCode?: string;
    serverStatus?: string;
  } | null;
}

export function ByosEnrollDialog({
  open,
  onOpenChange,
  onSuccess,
}: ByosEnrollDialogProps) {
  const t = useTranslations("console.byosEnroll");
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<EnrollmentPhase>("generate");
  const [enrollData, setEnrollData] = useState<EnrollmentData | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [regCode, setRegCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Reset state when dialog closes
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setPhase("generate");
        setEnrollData(null);
        setServerInfo(null);
        setRegCode(null);
        setCopied(false);
        setTimeLeft(0);
        setError(null);
      }
      onOpenChange(open);
    },
    [onOpenChange],
  );

  // Create enrollment token
  const enrollMutation = useMutation({
    mutationFn: async () => {
      const response = await api.api.byos.enroll.$post();
      if (!response.ok) {
        const errorData = (await response.json()) as { error?: string };
        throw new Error(errorData.error || t("errorEnrollFailed"));
      }
      return response.json() as Promise<EnrollmentData>;
    },
    onSuccess: (data) => {
      setEnrollData(data);
      setPhase("waiting");
      setError(null);

      // Calculate time left
      const expiresMs = new Date(data.expiresAt).getTime() - Date.now();
      setTimeLeft(Math.max(0, Math.floor(expiresMs / 1000)));
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : t("errorTokenFailed"));
    },
  });

  // Poll enrollment status while waiting
  const { data: statusData } = useQuery<StatusResponse>({
    queryKey: ["byosStatus"],
    queryFn: async () => {
      const response = await api.api.byos.status.$get();
      if (!response.ok) throw new Error(t("errorFetchStatus"));
      return response.json() as Promise<StatusResponse>;
    },
    enabled: open && (phase === "waiting" || phase === "detected" || phase === "installing"),
    refetchInterval: phase === "waiting" ? 3000 : phase === "installing" ? 5000 : false,
  });

  // React to status changes
  useEffect(() => {
    if (!statusData?.enrollment) return;
    const { enrollment } = statusData;

    if (enrollment.status === "expired" && phase === "waiting") {
      setError(t("errorTokenExpired"));
      setPhase("generate");
      setEnrollData(null);
      return;
    }

    if (
      (enrollment.status === "installing" || enrollment.status === "ready") &&
      enrollment.serverInfo
    ) {
      setServerInfo(enrollment.serverInfo);
      if (enrollment.registrationCode) setRegCode(enrollment.registrationCode);

      if (enrollment.status === "ready") {
        setPhase("ready");
        queryClient.invalidateQueries({ queryKey: ["server-status"] });
      } else if (phase === "waiting") {
        setPhase("detected");
        // Auto-transition to installing after showing detection
        setTimeout(() => setPhase("installing"), 2500);
      } else if (phase !== "ready") {
        setPhase("installing");
      }
    }
  }, [statusData, phase, queryClient]);

  // Countdown timer
  useEffect(() => {
    if (phase !== "waiting" || timeLeft <= 0) return;
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          setError(t("errorTokenExpiredCountdown"));
          setPhase("generate");
          setEnrollData(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [phase, timeLeft]);

  const handleCopy = async () => {
    if (!enrollData?.installCommand) return;
    try {
      await navigator.clipboard.writeText(enrollData.installCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for non-secure contexts
      const textarea = document.createElement("textarea");
      textarea.value = enrollData.installCommand;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const handleReady = () => {
    handleOpenChange(false);
    onSuccess?.();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <EllulLogo className="h-5 w-5 text-cream/65" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>
            {t("subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Phase 1: Generate Token */}
          {phase === "generate" && (
            <>
              <div className="rounded-lg p-4 border bg-sodium dark:bg-ink-2/20 border-sodium dark:border-sodium">
                <div className="flex items-start gap-3">
                  <Terminal className="h-5 w-5 text-cream/65 dark:text-cream/65 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-cream/65 dark:text-cream/65">
                      {t("introTitle")}
                    </p>
                    <p className="text-sm mt-1 text-cream/65 dark:text-cream/65">
                      {t("introBody")}
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-2 text-sm">
                <p className="font-medium">{t("supportedPlatforms")}</p>
                <ul className="text-muted-foreground space-y-1">
                  <li className="flex items-center gap-2">
                    <Monitor className="h-3 w-3" />
                    {t("platformMac")}
                  </li>
                  <li className="flex items-center gap-2">
                    <Terminal className="h-3 w-3" />
                    {t("platformLinux")}
                  </li>
                </ul>
              </div>

              <div className="space-y-2 text-sm">
                <p className="font-medium">{t("requirements")}</p>
                <ul className="text-muted-foreground space-y-1">
                  <li className="flex items-center gap-2">
                    <MemoryStick className="h-3 w-3" />
                    {t("reqRam")}
                  </li>
                  <li className="flex items-center gap-2">
                    <HardDrive className="h-3 w-3" />
                    {t("reqDisk")}
                  </li>
                  <li className="flex items-center gap-2">
                    <Shield className="h-3 w-3" />
                    {t("reqRoot")}
                  </li>
                </ul>
              </div>
            </>
          )}

          {/* Phase 2: Waiting for Connection */}
          {phase === "waiting" && enrollData && (
            <>
              <div className="space-y-3">
                <label className="text-sm font-medium">
                  {t("runOnYourServer")}
                </label>
                <div className="relative rounded-lg border border-[rgba(245, 239, 230, 0.07)] bg-black/40 p-3">
                  <code className="block text-xs font-mono text-cream/75 break-all pr-10 leading-relaxed">
                    {enrollData.installCommand}
                  </code>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="absolute top-2.5 right-2.5 p-1.5 rounded-md hover:bg-cream/10 transition-colors"
                  >
                    {copied ? (
                      <CheckCheck className="h-4 w-4 text-green-400" />
                    ) : (
                      <Copy className="h-4 w-4 text-cream/60" />
                    )}
                  </button>
                </div>
              </div>

              {/* Countdown */}
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2 text-cream/60">
                  <div className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sodium opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-sodium" />
                  </div>
                  {t("waitingForConnection")}
                </div>
                <span className="text-cream/45 font-mono text-xs">
                  {t("expiresIn", { time: formatTime(timeLeft) })}
                </span>
              </div>

              <div className="rounded-lg p-3 border border-sodium/20 bg-sodium/5">
                <p
                  className="text-xs text-sodium"
                  dangerouslySetInnerHTML={{ __html: t("sudoNote") }}
                />
              </div>
            </>
          )}

          {/* Phase 3: Node Detected */}
          {phase === "detected" && serverInfo && (
            <div className="space-y-4">
              <div className="rounded-lg p-4 border border-green-500/30 bg-green-500/5">
                <div className="flex items-start gap-3">
                  <CheckCircle className="h-5 w-5 text-green-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-green-400">
                      {t("nodeConnected")}
                    </p>
                    <p className="text-sm mt-1 text-cream/60">
                      {t("nodeConnectedSubtitle", {
                        os: serverInfo.os,
                        hostname: serverInfo.hostname,
                      })}
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg border border-[rgba(245, 239, 230, 0.07)] bg-black/30 p-3">
                  <Cpu className="h-4 w-4 text-sodium mx-auto mb-1" />
                  <p className="text-xs text-cream/60">{t("cpuLabel")}</p>
                  <p className="text-sm font-medium">{t("cpuValue", { cores: serverInfo.cpu_cores })}</p>
                </div>
                <div className="rounded-lg border border-[rgba(245, 239, 230, 0.07)] bg-black/30 p-3">
                  <MemoryStick className="h-4 w-4 text-sodium mx-auto mb-1" />
                  <p className="text-xs text-cream/60">{t("ramLabel")}</p>
                  <p className="text-sm font-medium">{t("ramValue", { gb: Math.round(serverInfo.ram_mb / 1024) })}</p>
                </div>
                <div className="rounded-lg border border-[rgba(245, 239, 230, 0.07)] bg-black/30 p-3">
                  <HardDrive className="h-4 w-4 text-sodium mx-auto mb-1" />
                  <p className="text-xs text-cream/60">{t("diskLabel")}</p>
                  <p className="text-sm font-medium">{t("diskValue", { gb: serverInfo.disk_gb })}</p>
                </div>
              </div>

              {regCode && (
                <div className="rounded-lg p-3 border border-sodium/30 bg-sodium/5 text-center">
                  <p className="text-xs text-cream/60 mb-1">{t("confirmationCode")}</p>
                  <p className="text-2xl font-mono font-bold tracking-wider text-cream/65">
                    {regCode}
                  </p>
                  <p className="text-xs text-cream/45 mt-1">
                    {t("confirmationCodeNote")}
                  </p>
                </div>
              )}

              {serverInfo.platform === "macos" && (
                <div className="rounded-lg p-3 border border-sodium/20 bg-sodium/5">
                  <p className="text-xs text-sodium">
                    {t("macosDiskNote")}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Phase 4: Installing */}
          {phase === "installing" && (
            <div className="space-y-4">
              {serverInfo && (
                <div className="flex items-center gap-3 text-sm text-cream/60">
                  <EllulLogo className="h-4 w-4 text-cream/65 shrink-0" />
                  <span>
                    {t("serverSummary", {
                      os: serverInfo.os,
                      cores: serverInfo.cpu_cores,
                      ram: Math.round(serverInfo.ram_mb / 1024),
                    })}
                  </span>
                </div>
              )}

              {regCode && (
                <div className="rounded-lg p-3 border border-sodium/30 bg-sodium/5 text-center">
                  <p className="text-xs text-cream/60 mb-1">{t("confirmationCode")}</p>
                  <p className="text-2xl font-mono font-bold tracking-wider text-cream/65">
                    {regCode}
                  </p>
                </div>
              )}

              <div className="flex items-center justify-center py-4">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full border-4 border-sodium/20" />
                  <div className="absolute inset-0 w-16 h-16 rounded-full border-4 border-sodium border-t-transparent animate-spin" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <EllulLogo className="h-6 w-6 text-sodium" />
                  </div>
                </div>
              </div>

              <div className="text-center">
                <p className="text-sm font-medium text-cream">
                  {t("installingTitle")}
                </p>
                <p className="text-xs text-cream/60 mt-1">
                  {t("installingSubtitle")}
                </p>
              </div>
            </div>
          )}

          {/* Phase 5: Ready */}
          {phase === "ready" && (
            <div className="space-y-4">
              <div className="flex items-center justify-center py-4">
                <div className="relative">
                  <div className="w-16 h-16 rounded-full border-4 border-green-500/30 bg-green-500/5 flex items-center justify-center">
                    <CheckCircle className="h-8 w-8 text-green-500" />
                  </div>
                </div>
              </div>

              <div className="text-center">
                <p className="text-lg font-semibold text-cream">
                  {t("readyTitle")}
                </p>
                {serverInfo && (
                  <p className="text-sm text-cream/60 mt-1">
                    {t("readySummary", {
                      os: serverInfo.os,
                      hostname: serverInfo.hostname,
                      cores: serverInfo.cpu_cores,
                      ram: Math.round(serverInfo.ram_mb / 1024),
                    })}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
              <p className="text-sm text-destructive flex items-center gap-2">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                {error}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          {phase === "generate" && (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t("cancel")}
              </Button>
              <Button
                onClick={() => {
                  setError(null);
                  enrollMutation.mutate();
                }}
                disabled={enrollMutation.isPending}
              >
                {enrollMutation.isPending ? (
                  <>
                    <Spinner size="sm" className="mr-2" />
                    {t("generating")}
                  </>
                ) : (
                  t("generateToken")
                )}
              </Button>
            </>
          )}

          {phase === "waiting" && (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t("cancel")}
            </Button>
          )}

          {(phase === "detected" || phase === "installing") && (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t("close")}
            </Button>
          )}

          {phase === "ready" && (
            <Button onClick={handleReady}>{t("openDashboard")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

