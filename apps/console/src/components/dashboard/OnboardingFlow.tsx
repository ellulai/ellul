// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { GitBranch, ArrowLeft, Plus, Sparkles, Layers, FileCode, FolderUp } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useAppsList } from "@/contexts/AppsListContext";
import { isTauriApp } from "@/lib/utils";
import { API_URL } from "@/lib/api";
import { ProviderCard, ProviderLogo, PROVIDER_INFO, type GitProvider } from "./git/ProviderCard";
import { RepoPicker, type NormalizedRepo } from "./git/RepoPicker";
import { CreateRepoDialog } from "./git/CreateRepoDialog";
import { LocalGitOnboarding } from "./git/LocalGitOnboarding";
import { WorkspaceTypePicker } from "./WorkspaceTypePicker";
import {
  FrameworkPicker,
  FRAMEWORK_OPTIONS,
  MONOREPO_OPTIONS,
  DEFAULT_FRAMEWORK_ID,
} from "./workspace/FrameworkPicker";
import { DEFAULT_PRESET_ID, WORKSPACE_PRESETS } from "@/lib/workspace-presets";
import { useVpsBridge } from "@/lib/vps-bridge";
import type { SandboxProgressEvent } from "@/lib/create-sandbox-stream";

// Human labels for SSE progress events shown in the "importing" step.
// Translated at render time from `console.onboarding.progress.*`.
const PROGRESS_KEY: Record<SandboxProgressEvent["stage"], string> = {
  creating_sandbox: "creatingSandbox",
  scaffolding: "scaffolding",
  cloning: "cloning",
  uploading: "uploading",
  extracting: "extracting",
  writing_metadata: "writingMetadata",
  installing_deps: "installingDeps",
  detecting: "detecting",
};

const SESSION_KEY = "ps_onboarding_state";

interface GitConnection {
  id: string;
  provider: GitProvider;
  providerUsername: string | null;
  providerAvatarUrl: string | null;
  scope: string | null;
  connectedAt: string;
}

interface OnboardingFlowProps {
  serverId: string;
  serverDomain: string;
  onComplete: (targetDirectory: string) => void;
  isModal?: boolean;
  securityTier?: "standard" | "web_locked" | "private_locked";
  product?: string;
  footerEl?: HTMLElement | null;
}

export function OnboardingFlow({ serverId, serverDomain, onComplete, isModal = false, securityTier = "standard", product, footerEl }: OnboardingFlowProps) {
  const t = useTranslations("console.onboarding");
  const { createSandbox, uploadSandbox, registerLocalProject, deleteSandbox, isCreatingSandbox, sandboxes } = useAppsList();
  const isLocal = product === "self_hosted";
  const queryClient = useQueryClient();
  const { send: vpsSend } = useVpsBridge();

  const progressFor = (stage: SandboxProgressEvent["stage"]): string => {
    const key = PROGRESS_KEY[stage];
    if (key === "creatingSandbox") return t("progress.creatingSandbox");
    if (key === "scaffolding") return t("progress.scaffolding");
    if (key === "cloning") return t("progress.cloning");
    if (key === "uploading") return t("progress.uploading");
    if (key === "extracting") return t("progress.extracting");
    if (key === "writingMetadata") return t("progress.writingMetadata");
    if (key === "installingDeps") return t("progress.installingDeps");
    if (key === "detecting") return t("progress.detecting");
    return t("progress.working");
  };

  const [step, setStep] = useState<
    "choose" | "workspace-type" | "project-type" | "framework" | "name" | "git-connect" | "upload" | "importing"
  >("workspace-type");
  const [flowType, setFlowType] = useState<"scaffold" | "git" | "upload">("scaffold");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [localPath, setLocalPath] = useState("");
  const [sandboxId, setSandboxId] = useState("");
  const [frameworkId, setFrameworkId] = useState<string>(DEFAULT_FRAMEWORK_ID);
  const [workspacePresetId, setWorkspacePresetId] = useState<string>(DEFAULT_PRESET_ID);
  const [error, setError] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<GitProvider | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  // the "Cancel" button in the importing step so users never have to wait out
  const abortRef = useRef<AbortController | null>(null);
  // The last submission's payload, used by the "Try again" button to re-fire
  const [lastSubmission, setLastSubmission] = useState<
    | { kind: "scaffold"; name: string; framework: string }
    | {
        kind: "git";
        provider: GitProvider;
        repoFullName: string;
        repoUrl: string;
        defaultBranch: string;
        isPrivate: boolean;
        name: string;
        branch?: string;
      }
    | { kind: "upload"; name: string; file: File }
    | { kind: "local"; name: string; localPath: string }
    | null
  >(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState("");

  // Fetch connected git providers
  const { data: connectionsData, isLoading: loadingConnections } = useQuery<{
    connections: GitConnection[];
    availableProviders: GitProvider[];
  }>({
    queryKey: ["git-connections"],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/git/connections`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(t("errors.loadConnections"));
      return res.json();
    },
    enabled: step === "git-connect",
    retry: isLocal ? 0 : 3,
  });


  const connections = connectionsData?.connections || [];
  const availableProviders = connectionsData?.availableProviders || ["github", "gitlab", "bitbucket"] as GitProvider[];

  // Auto-select first connected provider when entering git-connect
  useEffect(() => {
    const first = connections[0];
    if (step === "git-connect" && first && !activeProvider) {
      setActiveProvider(first.provider);
    }
  }, [step, connections, activeProvider]);

  // OAuth redirect survival: restore state after OAuth callback.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      if (!saved) return;
      const state = JSON.parse(saved) as { flowType: string; sandboxId: string };
      if (state.flowType === "git" && state.sandboxId) {
        setFlowType("git");
        setSandboxId(state.sandboxId);
        setStep("git-connect");
        sessionStorage.removeItem(SESSION_KEY);
        queryClient.invalidateQueries({ queryKey: ["git-connections"] });
      }
    } catch {
      // Ignore parse errors
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save state to sessionStorage before OAuth redirect
  const saveStateForOAuth = useCallback(() => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ flowType: "git", sandboxId }));
  }, [sandboxId]);

  const [waitingForOAuth, setWaitingForOAuth] = useState(false);

  const navigateToOAuth = useCallback((url: string) => {
    if (isTauriApp()) {
      const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
      if (invoke) {
        invoke("open_external", { url }).catch(() => {
          window.location.href = url;
        });
        setWaitingForOAuth(true);
        return;
      }
    }
    window.location.href = url;
  }, []);

  useEffect(() => {
    if (!waitingForOAuth) return;
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["git-connections"] });
    }, 3000);
    return () => clearInterval(interval);
  }, [waitingForOAuth, queryClient]);

  useEffect(() => {
    if (waitingForOAuth && connections.length > 0) {
      setWaitingForOAuth(false);
      if (!activeProvider) setActiveProvider(connections[0]!.provider);
    }
  }, [waitingForOAuth, connections, activeProvider]);

  const validateName = (): boolean => {
    const trimmed = sandboxId.trim();
    if (!trimmed) {
      setError(t("errors.enterName"));
      return false;
    }
    if (sandboxes.some(s => s.displayName.toLowerCase() === trimmed.toLowerCase())) {
      setError(t("errors.duplicateName"));
      return false;
    }
    setError(null);
    return true;
  };

  const saveWorkspacePreset = async (targetDirectory: string) => {
    try {
      const { expandPreset } = await import("@/lib/workspace-presets");
      const { createDefaultRegistry } = await import("@/lib/workspace-extensions");
      const registry = createDefaultRegistry();
      const config = expandPreset(workspacePresetId, registry);
      await fetch(`${API_URL}/api/servers/${serverId}/workspace/${encodeURIComponent(targetDirectory)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
    } catch {
      // Non-fatal — sandbox works with default preset
    }

    const preset = WORKSPACE_PRESETS.get(workspacePresetId);
    if (preset) {
      try {
        await vpsSend("set_view_mode", { mode: preset.defaultViewMode });
      } catch {
        // Non-fatal — user can change appearance later in Platform Settings
      }
    }
  };

  const { cloneSandbox } = useAppsList();

  // Shared runner for scaffold-path submissions. Owns the AbortController
  const runScaffold = useCallback(
    async (payload: { name: string; framework: string }) => {
      setLastSubmission({ kind: "scaffold", ...payload });
      setStep("importing");
      setError(null);
      setImportStatus(progressFor("creating_sandbox"));
      const controller = new AbortController();
      abortRef.current = controller;
      const result = await createSandbox(payload.name, {
        framework: payload.framework,
        signal: controller.signal,
        onProgress: (ev) => setImportStatus(progressFor(ev.stage)),
      });
      abortRef.current = null;
      if (result.success && result.app) {
        sessionStorage.removeItem(SESSION_KEY);
        await saveWorkspacePreset(result.app.directory);
        onComplete(result.app.directory);
      } else {
        setError(result.error || t("errors.createFailed"));
        setStep("name");
      }
    },
    [createSandbox, onComplete, saveWorkspacePreset],
  );

  // sandbox slug (so the stored `sandboxId` is the real `sbx-xxx/repoName`
  const runClone = useCallback(
    async (payload: {
      provider: GitProvider;
      repoFullName: string;
      repoUrl: string;
      defaultBranch: string;
      isPrivate: boolean;
      name: string;
      branch?: string;
    }) => {
      setLastSubmission({ kind: "git", ...payload });
      setStep("importing");
      setLinkError(null);
      setImportStatus(progressFor("creating_sandbox"));
      const controller = new AbortController();
      abortRef.current = controller;

      // not just *server* identity. aiProxyToken alone must never be
      let vpsConfirmToken: string | undefined;
      if (securityTier !== "standard") {
        try {
          const authResult = await vpsSend<{ authorized: boolean; token: string | null }>(
            "authorize_git_link",
            { repoFullName: payload.repoFullName, provider: payload.provider },
          );
          if (!authResult.authorized || !authResult.token) {
            abortRef.current = null;
            setLinkError(t("errors.passkeyDeclined"));
            setStep("git-connect");
            return;
          }
          vpsConfirmToken = authResult.token;
        } catch (err) {
          abortRef.current = null;
          setLinkError(
            err instanceof Error
              ? `Passkey authorization failed: ${err.message}`
              : t("errors.passkeyFailed"),
          );
          setStep("git-connect");
          return;
        }
      }

      const result = await cloneSandbox(payload.provider, payload.repoFullName, payload.name, {
        ...(payload.branch ? { branch: payload.branch } : {}),
        repoUrl: payload.repoUrl,
        defaultBranch: payload.defaultBranch,
        isPrivate: payload.isPrivate,
        ...(vpsConfirmToken ? { vpsConfirmToken } : {}),
        signal: controller.signal,
        onProgress: (ev) => setImportStatus(progressFor(ev.stage)),
      });
      abortRef.current = null;
      if (result.success && result.app) {
        await saveWorkspacePreset(result.app.directory);
        sessionStorage.removeItem(SESSION_KEY);
        onComplete(result.app.directory);
      } else {
        setLinkError(result.error || t("errors.importFailed"));
        setStep("git-connect");
      }
    },
    [cloneSandbox, onComplete, saveWorkspacePreset, securityTier, vpsSend],
  );

  const runUpload = useCallback(
    async (payload: { name: string; file: File }) => {
      setLastSubmission({ kind: "upload", ...payload });
      setStep("importing");
      setError(null);
      setImportStatus(progressFor("uploading"));
      const controller = new AbortController();
      abortRef.current = controller;
      const result = await uploadSandbox(payload.name, {
        file: payload.file,
        signal: controller.signal,
        onProgress: (ev) => setImportStatus(progressFor(ev.stage)),
      });
      abortRef.current = null;
      if (result.success && result.app) {
        sessionStorage.removeItem(SESSION_KEY);
        await saveWorkspacePreset(result.app.directory);
        onComplete(result.app.directory);
      } else {
        setError(result.error || t("errors.createFailed"));
        setStep("upload");
      }
    },
    [uploadSandbox, onComplete, saveWorkspacePreset],
  );

  const runLocalRegister = useCallback(
    async (payload: { name: string; localPath: string }) => {
      setLastSubmission({ kind: "local", ...payload });
      setStep("importing");
      setError(null);
      setImportStatus(progressFor("creating_sandbox"));
      const controller = new AbortController();
      abortRef.current = controller;
      const result = await registerLocalProject(payload.name, {
        localPath: payload.localPath,
        signal: controller.signal,
        onProgress: (ev) => setImportStatus(progressFor(ev.stage)),
      });
      abortRef.current = null;
      if (result.success && result.app) {
        sessionStorage.removeItem(SESSION_KEY);
        await saveWorkspacePreset(result.app.directory);
        onComplete(result.app.directory);
      } else {
        setError(result.error || t("errors.createFailed"));
        setStep("upload");
      }
    },
    [registerLocalProject, onComplete, saveWorkspacePreset],
  );

  const handleCreateScaffold = () => {
    if (isCreatingSandbox) return;
    if (!validateName()) return;
    void runScaffold({ name: sandboxId.trim(), framework: frameworkId });
  };

  const handleSelectRepo = (repo: NormalizedRepo) => {
    if (!activeProvider) return;
    void runClone({
      provider: activeProvider,
      repoFullName: repo.fullName,
      repoUrl: repo.url,
      defaultBranch: repo.defaultBranch,
      isPrivate: repo.isPrivate,
      name: sandboxId.trim(),
    });
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setImportStatus(t("progress.cancelling"));
    setError(null);
    setLinkError(null);
    // After the abort propagates, the promise settles with code: 'cancelled'
    setStep(lastSubmission?.kind === "git" ? "git-connect" : (lastSubmission?.kind === "upload" || lastSubmission?.kind === "local") ? "upload" : "name");
  };

  const handleRetry = () => {
    const last = lastSubmission;
    if (!last) return;
    if (last.kind === "scaffold") {
      void runScaffold({ name: last.name, framework: last.framework });
    } else if (last.kind === "upload") {
      void runUpload({ name: last.name, file: last.file });
    } else if (last.kind === "local") {
      void runLocalRegister({ name: last.name, localPath: last.localPath });
    } else {
      void runClone({
        provider: last.provider,
        repoFullName: last.repoFullName,
        repoUrl: last.repoUrl,
        defaultBranch: last.defaultBranch,
        isPrivate: last.isPrivate,
        name: last.name,
        ...(last.branch ? { branch: last.branch } : {}),
      });
    }
  };

  // Handle "Continue" from name step to git-connect
  const handleContinueToGit = () => {
    if (!validateName()) return;
    setStep("git-connect");
  };

  return (
    <div className={isModal ? "p-5" : "flex-1 flex items-center justify-center p-4"}>
      <div className={`w-full ${isModal ? "" : "max-w-lg"}`}>
        {/* Step: Choose */}
        {step === "choose" && (
          <>
            {!isModal ? (
              <div className="text-center mb-6">
                <h1 className="text-2xl font-bold text-cream mb-2">{t("choose.title")}</h1>
                <p className="text-sm text-cream/60">{t("choose.subtitle")}</p>
              </div>
            ) : (
              <p className="text-xs text-cream/45 mb-3">{t("choose.compactPrompt")}</p>
            )}

            <div className="space-y-3">
              <button
                onClick={() => {
                  setFlowType("scaffold");
                  setStep("project-type");
                }}
                className="w-full flex items-start gap-4 p-4 rounded-xl bg-card border border-border hover:border-sodium/50 transition-colors text-left group"
              >
                <div className="w-12 h-12 rounded-lg bg-sodium/10 flex items-center justify-center shrink-0 group-hover:bg-sodium/20 transition-colors">
                  <Sparkles className="h-6 w-6 text-sodium" />
                </div>
                <div>
                  <h3 className="font-semibold text-cream mb-1">{t("choose.scaffold.title")}</h3>
                  <p className="text-sm text-cream/60">{t("choose.scaffold.description")}</p>
                </div>
              </button>

              <button
                onClick={() => {
                  setFlowType("git");
                  setStep("name");
                }}
                className="w-full flex items-start gap-4 p-4 rounded-xl bg-card border border-border hover:border-cyan-500/50 transition-colors text-left group"
              >
                <div className="w-12 h-12 rounded-lg bg-cyan-500/10 flex items-center justify-center shrink-0 group-hover:bg-cyan-500/20 transition-colors">
                  <GitBranch className="h-6 w-6 text-cyan-500" />
                </div>
                <div>
                  <h3 className="font-semibold text-cream mb-1">{t("choose.git.title")}</h3>
                  <p className="text-sm text-cream/60">{t("choose.git.description")}</p>
                </div>
              </button>

              {/* Upload from desktop — hidden until upload flow is fixed
              <button
                onClick={() => {
                  setFlowType("upload");
                  setStep("name");
                }}
                className="w-full flex items-start gap-4 p-4 rounded-xl bg-card border border-border hover:border-green-500/50 transition-colors text-left group"
              >
                <div className="w-12 h-12 rounded-lg bg-green-500/10 flex items-center justify-center shrink-0 group-hover:bg-green-500/20 transition-colors">
                  <FolderUp className="h-6 w-6 text-green-500" />
                </div>
                <div>
                  <h3 className="font-semibold text-cream mb-1">{isLocal ? t("choose.local.title") : t("choose.upload.title")}</h3>
                  <p className="text-sm text-cream/60">{isLocal ? t("choose.local.description") : t("choose.upload.description")}</p>
                </div>
              </button>
              */}

              <button
                onClick={() => setStep("workspace-type")}
                className="w-full py-2 text-sm text-cream/45 hover:text-cream/75 transition-colors"
              >
                {t("buttons.back")}
              </button>
            </div>
          </>
        )}

        {/* Step: Workspace Type */}
        {step === "workspace-type" && (
          <>
            {!isModal ? (
              <div className="text-center mb-6">
                <h1
                  className="text-2xl font-bold text-cream mb-2 animate-fade-in-up"
                >
                  {t("workspaceType.title")}
                </h1>
                <p
                  className="text-sm text-cream/60 animate-fade-in-up"
                  style={{ animationDelay: "60ms", animationFillMode: "backwards" }}
                >
                  {t("workspaceType.subtitle")}
                </p>
              </div>
            ) : (
              <p
                className="text-xs text-cream/45 mb-3 animate-fade-in-up"
                style={{ animationDelay: "60ms", animationFillMode: "backwards" }}
              >
                {t("workspaceType.compactPrompt")}
              </p>
            )}

            <div className="space-y-4">
              <WorkspaceTypePicker
                selectedPresetId={workspacePresetId}
                onSelect={setWorkspacePresetId}
              />
            </div>
            {(() => {
              const actions = (
                <div className={footerEl ? "px-5 py-3 border-t border-border" : isModal ? "pt-4" : "mt-4"}>
                  <button
                    onClick={() => setStep("choose")}
                    className="w-full py-2.5 rounded-xl bg-sodium hover:bg-sodium text-ink text-sm font-semibold transition-all hover:shadow-neon-bright flex items-center justify-center gap-2"
                  >
                    {t("buttons.continue")}
                  </button>
                </div>
              );
              return footerEl ? createPortal(actions, footerEl) : actions;
            })()}
          </>
        )}

        {/* Step: Project Type — single app vs monorepo */}
        {step === "project-type" && (
          <>
            <div className="mb-4 flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-sodium/10 flex items-center justify-center flex-none">
                <Sparkles className="h-4 w-4 text-sodium" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-cream leading-tight">{t("projectStructure.title")}</h2>
                <p className="text-xs text-cream/45 leading-snug truncate">{t("projectStructure.subtitle")}</p>
              </div>
            </div>

            <div className="space-y-3">
              <button
                onClick={() => setStep("framework")}
                className="w-full flex items-start gap-4 p-4 rounded-xl bg-card border border-border hover:border-sodium/50 transition-colors text-left group"
              >
                <div className="w-12 h-12 rounded-lg bg-sodium/10 flex items-center justify-center shrink-0 group-hover:bg-sodium/20 transition-colors">
                  <FileCode className="h-6 w-6 text-sodium" />
                </div>
                <div>
                  <h3 className="font-semibold text-cream mb-1">{t("projectStructure.singleApp")}</h3>
                  <p className="text-sm text-cream/60">{t("projectStructure.singleAppDescription")}</p>
                </div>
              </button>

              <button
                onClick={() => {
                  setFrameworkId("turbo");
                  setStep("name");
                }}
                className="w-full flex items-start gap-4 p-4 rounded-xl bg-card border border-border hover:border-cream/[0.12] transition-colors text-left group"
              >
                <div className="w-12 h-12 rounded-lg bg-cream/[0.04] flex items-center justify-center shrink-0 group-hover:bg-cream/[0.08] transition-colors">
                  <Layers className="h-6 w-6 text-cream/70" />
                </div>
                <div>
                  <h3 className="font-semibold text-cream mb-1">{t("projectStructure.monorepo")}</h3>
                  <p className="text-sm text-cream/60">{t("projectStructure.monorepoDescription")}</p>
                </div>
              </button>

            </div>
          </>
        )}

        {/* Step: Framework (scaffold flow only). Compact header keeps the
            picker + action row inside the modal without scroll on standard
            laptop viewports. */}
        {step === "framework" && (
          <>
            <div className="mb-4 flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-sodium/10 flex items-center justify-center flex-none">
                <Sparkles className="h-4 w-4 text-sodium" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-cream leading-tight">{t("framework.title")}</h2>
                <p className="text-xs text-cream/45 leading-snug truncate">{t("framework.subtitle")}</p>
              </div>
            </div>

            <div className="space-y-4">
              {/* The workspace preset the user picked at step 2 drives the
                  catalog view: studio sees Frontend/Backend quick picks,
                  developer sees the full 28-framework grid. */}
              <FrameworkPicker
                selectedId={frameworkId}
                onSelect={setFrameworkId}
                variant={workspacePresetId === "studio" ? "simple" : "advanced"}
                onAdvance={() => setStep("name")}
              />
            </div>
            {(() => {
              const actions = (
                <div className={footerEl ? "px-5 py-3 border-t border-border" : isModal ? "pt-4" : "mt-4"}>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setStep("project-type")}
                      className="flex-1 py-2.5 rounded-lg bg-card border border-border text-cream/60 hover:text-cream hover:border-cream/[0.08] text-sm font-medium transition-colors"
                    >
                      {t("buttons.back")}
                    </button>
                    {workspacePresetId !== "studio" && (
                      <button
                        onClick={() => setStep("name")}
                        disabled={!frameworkId}
                        className="flex-1 py-2.5 rounded-lg bg-sodium hover:bg-sodium disabled:opacity-50 text-ink text-sm font-semibold transition-colors"
                      >
                        {t("buttons.continue")}
                      </button>
                    )}
                  </div>
                </div>
              );
              return footerEl ? createPortal(actions, footerEl) : actions;
            })()}
          </>
        )}

        {/* Step: Name */}
        {step === "name" && (
          <>
            {isModal ? (
              <div className="mb-3 flex items-center gap-3">
                <div className={`w-9 h-9 rounded-lg ${flowType === "scaffold" ? "bg-sodium/10" : flowType === "upload" ? "bg-green-500/10" : "bg-cyan-500/10"} flex items-center justify-center flex-none`}>
                  {flowType === "scaffold" ? (
                    <Sparkles className="h-4 w-4 text-sodium" />
                  ) : flowType === "upload" ? (
                    <FolderUp className="h-4 w-4 text-green-500" />
                  ) : (
                    <GitBranch className="h-4 w-4 text-cyan-500" />
                  )}
                </div>
                <h2 className="text-base font-semibold text-cream leading-tight">
                  {flowType === "scaffold"
                    ? (() => {
                        const fw = FRAMEWORK_OPTIONS.find((f) => f.id === frameworkId) ?? MONOREPO_OPTIONS.find((f) => f.id === frameworkId);
                        return fw ? t("name.scaffoldHeading", { framework: fw.label }) : t("name.scaffoldHeadingFallback");
                      })()
                    : flowType === "upload" ? (isLocal ? t("name.localHeading") : t("name.uploadHeading"))
                    : t("name.gitHeading")}
                </h2>
              </div>
            ) : (
              <div className="text-center mb-6">
                <div className={`w-16 h-16 rounded-2xl ${flowType === "scaffold" ? "bg-sodium/10" : flowType === "upload" ? "bg-green-500/10" : "bg-cyan-500/10"} flex items-center justify-center mx-auto mb-4`}>
                  {flowType === "scaffold" ? (
                    <Sparkles className="h-8 w-8 text-sodium" />
                  ) : flowType === "upload" ? (
                    <FolderUp className="h-8 w-8 text-green-500" />
                  ) : (
                    <GitBranch className="h-8 w-8 text-cyan-500" />
                  )}
                </div>
                <h2 className="text-xl font-bold text-cream mb-1">
                  {flowType === "scaffold"
                    ? (() => {
                        const fw = FRAMEWORK_OPTIONS.find((f) => f.id === frameworkId) ?? MONOREPO_OPTIONS.find((f) => f.id === frameworkId);
                        return fw ? t("name.scaffoldHeading", { framework: fw.label }) : t("name.scaffoldHeadingFallback");
                      })()
                    : flowType === "upload" ? (isLocal ? t("name.localHeading") : t("name.uploadHeading"))
                    : t("name.gitHeading")}
                </h2>
                <p className="text-sm text-cream/60">
                  {flowType === "scaffold"
                    ? t("name.scaffoldSubtitle")
                    : flowType === "upload" ? (isLocal ? t("name.localSubtitle") : t("name.uploadSubtitle"))
                    : t("name.gitSubtitle")}
                </p>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-cream/75 mb-2">{t("name.label")}</label>
                <input
                  type="text"
                  value={sandboxId}
                  onChange={(e) => {
                    setSandboxId(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (flowType === "scaffold") handleCreateScaffold();
                      else if (flowType === "upload") { if (validateName()) setStep("upload"); }
                      else handleContinueToGit();
                    }
                  }}
                  placeholder={t("name.placeholder")}
                  className={`w-full px-4 py-3 rounded-lg bg-card border border-border text-cream placeholder:text-cream/45 focus:outline-none focus:ring-2 ${
                    flowType === "scaffold"
                      ? "focus:ring-sodium/50 focus:border-sodium"
                      : flowType === "upload"
                      ? "focus:ring-green-500/50 focus:border-green-500"
                      : "focus:ring-cyan-500/50 focus:border-cyan-500"
                  }`}
                  autoFocus
                />
                <p className="mt-2 text-xs text-cream/45">{t("name.hint")}</p>
              </div>

              {error && (
                <div className="p-3 rounded-lg bg-terra/10 border border-terra/30 text-sm text-terra">
                  {error}
                </div>
              )}
            </div>
            {(() => {
              const actions = (
                <div className={footerEl ? "px-5 py-3 space-y-2 border-t border-border" : isModal ? "pt-4 space-y-3" : "mt-4 space-y-3"}>
                  {flowType === "scaffold" ? (
                    <button
                      onClick={handleCreateScaffold}
                      disabled={isCreatingSandbox || !sandboxId.trim()}
                      className="w-full py-3 rounded-lg bg-sodium hover:bg-sodium disabled:opacity-50 disabled:cursor-not-allowed text-ink font-medium transition-colors flex items-center justify-center gap-2"
                    >
                      {isCreatingSandbox ? (
                        <>
                          <Spinner size="sm" />
                          {t("buttons.creating")}
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-4 w-4" />
                          {t("buttons.createSandbox")}
                        </>
                      )}
                    </button>
                  ) : flowType === "upload" ? (
                    <button
                      onClick={() => { if (validateName()) setStep("upload"); }}
                      disabled={!sandboxId.trim()}
                      className="w-full py-3 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-cream font-medium transition-colors flex items-center justify-center gap-2"
                    >
                      <FolderUp className="h-4 w-4" />
                      {t("buttons.continue")}
                    </button>
                  ) : (
                    <button
                      onClick={handleContinueToGit}
                      disabled={!sandboxId.trim()}
                      className="w-full py-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed text-cream font-medium transition-colors flex items-center justify-center gap-2"
                    >
                      <GitBranch className="h-4 w-4" />
                      {t("buttons.continue")}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (flowType !== "scaffold") { setStep("choose"); return; }
                      if (frameworkId === "turbo") { setStep("project-type"); return; }
                      setStep("framework");
                    }}
                    className="w-full py-2 text-sm text-cream/45 hover:text-cream/75 transition-colors"
                  >
                    {t("buttons.back")}
                  </button>
                </div>
              );
              return footerEl ? createPortal(actions, footerEl) : actions;
            })()}
          </>
        )}

        {/* Step: Git Connect */}
        {step === "git-connect" && (
          <>
            <button
              onClick={() => {
                setStep("name");
                setActiveProvider(null);
                setLinkError(null);
              }}
              className="flex items-center gap-2 text-sm text-cream/60 hover:text-cream mb-6 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              {t("buttons.back")}
            </button>

            <div className="text-center mb-6">
              <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 flex items-center justify-center mx-auto mb-4">
                <GitBranch className="h-8 w-8 text-cyan-500" />
              </div>
              <h2 className="text-xl font-bold text-cream mb-1">{t("git.title")}</h2>
              <p className="text-sm text-cream/60">
                {t.rich("git.subtitle", {
                  name: () => <span className="text-cyan-400 font-medium">{sandboxId}</span>,
                })}
              </p>
            </div>

            {linkError && (
              <div className="p-3 rounded-lg bg-terra/10 border border-terra/30 text-sm text-terra mb-4">
                {linkError}
              </div>
            )}

            {isLocal ? (
              <LocalGitOnboarding
                onSelectRepo={(repo) => {
                  setActiveProvider("github");
                  void runClone({
                    provider: "github",
                    repoFullName: repo.fullName,
                    repoUrl: repo.url,
                    defaultBranch: repo.defaultBranch,
                    isPrivate: repo.isPrivate,
                    name: sandboxId.trim(),
                  });
                }}
              />
            ) : (
              <>
                <div className="space-y-4">
                  {waitingForOAuth ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-3">
                      <Spinner size="default" color="primary" />
                      <p className="text-sm text-cream/60">{t("git.waitingForAuth")}</p>
                      <button
                        onClick={() => setWaitingForOAuth(false)}
                        className="text-xs text-cream/45 hover:text-cream/75 transition-colors"
                      >
                        {t("buttons.cancel")}
                      </button>
                    </div>
                  ) : loadingConnections ? (
                    <div className="flex items-center justify-center py-12">
                      <Spinner size="default" color="muted" delay={300} />
                    </div>
                  ) : connections.length === 0 ? (
                    // No providers connected — show provider cards
                    <div className="space-y-3">
                      <label className="block text-sm font-medium text-cream/75 mb-1">{t("git.providerLabel")}</label>
                      {availableProviders.map((provider) => (
                        <ProviderCard
                          key={provider}
                          provider={provider}
                          available={true}
                          onBeforeConnect={saveStateForOAuth}
                        />
                      ))}
                    </div>
                  ) : (
                    // Provider connected — show provider tabs + repo picker
                    <div className="space-y-4">
                      {/* Provider selector (if multiple connected) */}
                      {connections.length > 1 && (
                        <div className="flex gap-2">
                          {connections.map((conn) => {
                            const info = PROVIDER_INFO[conn.provider];
                            const isActive = activeProvider === conn.provider;
                            return (
                              <button
                                key={conn.provider}
                                onClick={() => setActiveProvider(conn.provider)}
                                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                                  isActive
                                    ? "bg-secondary text-cream border border-[#5D0099]"
                                    : "bg-card text-cream/60 border border-border hover:text-cream"
                                }`}
                              >
                                <ProviderLogo provider={conn.provider} className="h-4 w-4" />
                                {info?.name || conn.provider}
                              </button>
                            );
                          })}
                          {/* Button to connect additional provider */}
                          {availableProviders.some(p => !connections.find(c => c.provider === p)) && (
                            <button
                              onClick={() => {
                                // Find first unconnected provider and redirect
                                const unconnected = availableProviders.find(p => !connections.find(c => c.provider === p));
                                if (unconnected) {
                                  saveStateForOAuth();
                                  navigateToOAuth(`${API_URL}/api/git/connect/${unconnected}`);
                                }
                              }}
                              className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-cream/45 border border-dashed border-border hover:text-cream/75 hover:border-[#5D0099] transition-colors"
                            >
                              <Plus className="h-3 w-3" />
                              {t("git.addProvider")}
                            </button>
                          )}
                        </div>
                      )}

                      {/* Repo picker */}
                      {activeProvider && (
                        <RepoPicker
                          provider={activeProvider}
                          serverId={serverId}
                          onSelectRepo={handleSelectRepo}
                          onCreateNew={() => setShowCreateDialog(true)}
                        />
                      )}

                      {/* Connect another provider link (if only 1 connected) */}
                      {connections.length === 1 && (
                        <div className="text-center">
                          <p className="text-xs text-cream/45">
                            {t("git.connectedTo", { provider: connections[0] ? PROVIDER_INFO[connections[0].provider]?.name ?? "" : "" })}{" "}
                            {availableProviders.some(p => !connections.find(c => c.provider === p)) && (
                              <button
                                onClick={() => {
                                  const unconnected = availableProviders.find(p => !connections.find(c => c.provider === p));
                                  if (unconnected) {
                                    saveStateForOAuth();
                                    window.location.href = `${API_URL}/api/git/connect/${unconnected}`;
                                  }
                                }}
                                className="text-cyan-400 hover:text-cyan-300 underline"
                              >
                                {t("git.connectAnother")}
                              </button>
                            )}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Create repo dialog */}
                {activeProvider && (
                  <CreateRepoDialog
                    open={showCreateDialog}
                    onOpenChange={setShowCreateDialog}
                    provider={activeProvider}
                    serverId={serverId}
                    onCreated={(repo) => {
                      setShowCreateDialog(false);
                      handleSelectRepo(repo);
                    }}
                  />
                )}
              </>
            )}
          </>
        )}

        {/* Step: Upload / Local Path */}
        {step === "upload" && (
          <>
            <button
              onClick={() => {
                setStep("name");
                setUploadFile(null);
                setLocalPath("");
              }}
              className="flex items-center gap-2 text-sm text-cream/60 hover:text-cream mb-6 transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              {t("buttons.back")}
            </button>

            <div className="text-center mb-6">
              <div className="w-16 h-16 rounded-2xl bg-green-500/10 flex items-center justify-center mx-auto mb-4">
                <FolderUp className="h-8 w-8 text-green-500" />
              </div>
              <h2 className="text-xl font-bold text-cream mb-1">
                {isLocal ? t("local.title") : t("upload.title")}
              </h2>
              <p className="text-sm text-cream/60">
                {isLocal ? t("local.subtitle") : t("upload.subtitle")}
              </p>
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-terra/10 border border-terra/30 text-sm text-terra mb-4">
                {error}
              </div>
            )}

            {isLocal ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-cream/75 mb-2">{t("local.pathLabel")}</label>
                  <input
                    type="text"
                    value={localPath}
                    onChange={(e) => { setLocalPath(e.target.value); setError(null); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && localPath.trim()) {
                        if (!localPath.trim().startsWith("/")) {
                          setError(t("local.pathHint"));
                          return;
                        }
                        void runLocalRegister({ name: sandboxId.trim(), localPath: localPath.trim() });
                      }
                    }}
                    placeholder={t("local.pathPlaceholder")}
                    className="w-full px-4 py-3 rounded-lg bg-card border border-border text-cream placeholder:text-cream/45 focus:outline-none focus:ring-2 focus:ring-green-500/50 focus:border-green-500"
                    autoFocus
                  />
                  <p className="mt-2 text-xs text-cream/45">{t("local.pathHint")}</p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <label
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const file = e.dataTransfer.files[0];
                    if (file && file.name.endsWith(".zip")) {
                      setUploadFile(file);
                      setError(null);
                    } else {
                      setError(t("upload.zipOnly"));
                    }
                  }}
                  className="flex flex-col items-center justify-center p-8 rounded-xl border-2 border-dashed border-border hover:border-green-500/50 cursor-pointer transition-colors"
                >
                  <FolderUp className="h-10 w-10 text-cream/30 mb-3" />
                  <p className="text-sm text-cream/75 mb-1">
                    {uploadFile ? uploadFile.name : t("upload.dropzone")}
                  </p>
                  <p className="text-xs text-cream/45">
                    {uploadFile
                      ? `${(uploadFile.size / 1024 / 1024).toFixed(1)} MB`
                      : t("upload.dropzoneHint")}
                  </p>
                  <input
                    type="file"
                    accept=".zip"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setUploadFile(file);
                        setError(null);
                      }
                    }}
                  />
                </label>
              </div>
            )}

            {(() => {
              const actions = (
                <div className={footerEl ? "px-5 py-3 border-t border-border" : isModal ? "pt-4" : "mt-4"}>
                  {isLocal ? (
                    <button
                      onClick={() => {
                        if (!localPath.trim()) return;
                        if (!localPath.trim().startsWith("/")) {
                          setError(t("local.pathHint"));
                          return;
                        }
                        void runLocalRegister({ name: sandboxId.trim(), localPath: localPath.trim() });
                      }}
                      disabled={!localPath.trim() || !localPath.trim().startsWith("/") || isCreatingSandbox}
                      className="w-full py-3 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-cream font-medium transition-colors flex items-center justify-center gap-2"
                    >
                      {isCreatingSandbox ? (
                        <>
                          <Spinner size="sm" />
                          {t("buttons.creating")}
                        </>
                      ) : (
                        <>
                          <FolderUp className="h-4 w-4" />
                          {t("buttons.addProject")}
                        </>
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        if (!uploadFile) return;
                        void runUpload({ name: sandboxId.trim(), file: uploadFile });
                      }}
                      disabled={!uploadFile || isCreatingSandbox}
                      className="w-full py-3 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-cream font-medium transition-colors flex items-center justify-center gap-2"
                    >
                      {isCreatingSandbox ? (
                        <>
                          <Spinner size="sm" />
                          {t("buttons.uploading")}
                        </>
                      ) : (
                        <>
                          <FolderUp className="h-4 w-4" />
                          {t("buttons.upload")}
                        </>
                      )}
                    </button>
                  )}
                </div>
              );
              return footerEl ? createPortal(actions, footerEl) : actions;
            })()}
          </>
        )}

        {/* Step: Importing — live SSE progress with Cancel + Retry affordances. */}
        {step === "importing" && (
          <div className="text-center py-12">
            <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 flex items-center justify-center mx-auto mb-6">
              <Spinner size="lg" color="primary" />
            </div>
            <h2 className="text-xl font-bold text-cream mb-2">{t("importing.title")}</h2>
            <p className="text-sm text-cream/60 mb-6">{importStatus}</p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={handleCancel}
                disabled={!abortRef.current}
                className="px-4 py-2 rounded-lg border border-border bg-card text-sm text-cream/75 hover:text-cream hover:border-cream/[0.08] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Error overlay — scaffold path surfaces inline on the name step via
            `error`, git path via `linkError`. The importing-step toast shows
            a dedicated Try-again button so the user doesn't have to walk back
            through the wizard to retry the same submission. */}
        {(error || linkError) && step !== "importing" && lastSubmission && (
          <div className="mt-4 p-3 rounded-lg bg-terra/10 border border-terra/30 text-sm text-terra flex items-center justify-between gap-3">
            <span className="truncate">{error || linkError}</span>
            <button
              onClick={handleRetry}
              className="shrink-0 px-3 py-1.5 rounded-md bg-terra/20 hover:bg-terra/30 text-terra text-xs font-medium transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
