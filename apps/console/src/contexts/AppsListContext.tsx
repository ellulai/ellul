// SPDX-License-Identifier: MIT
"use client";

import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useRealtimeSubscribe, type RealtimeMessage } from "@/providers/realtime-provider";
import { getCodeApiUrl } from "@/lib/domains";
import { useCodeToken, AuthenticationError } from "@/contexts/CodeTokenContext";
import { usePreviewLifecycleSync } from "@/hooks/usePreviewLifecycleSync";
import { MOCK_MODE, mockSandboxes } from "@/lib/mock-data";
import {
  createSandboxStream,
  uploadSandboxStream,
  SandboxStreamError_,
  type SandboxProgressEvent,
} from "@/lib/create-sandbox-stream";

export interface ApiSandbox {
  id: string;
  displayName: string;
  path: string;
  pinned: boolean;
  createdAt?: string;
  activeApp: string | null;
  apps: ApiApp[];
}

export interface ApiApp {
  directory: string;
  sandboxId: string;
  subdir: string;
  name: string;
  displayName?: string;
  path: string;
  framework: string;
  type: "frontend" | "backend" | "library" | "monorepo" | "unknown";
  previewable: boolean;
  port: number;
  scripts?: string[];
  dependencies?: string[];
  hasPackageJson: boolean;
  isMonorepo: boolean;
  packages?: string[];
  workspacePackages: ApiPackage[];
  origin?: "scaffold" | "git" | "blank";
  projectId: string | null;
}

export interface ApiPackage {
  directory: string;
  sandboxId: string;
  appRoot: string;
  name: string;
  displayName?: string;
  path: string;
  framework: string;
  type: "frontend" | "backend" | "library" | "unknown";
  previewable: boolean;
  port: number;
  scripts?: string[];
  dependencies?: string[];
  hasPackageJson: boolean;
  projectId: string | null;
}

export interface ApiActiveSelection {
  sandbox: string | null;
  app: string | null;
}

export function findSandbox(sandboxes: ApiSandbox[], sandboxId: string): ApiSandbox | null {
  return sandboxes.find((s) => s.id === sandboxId) ?? null;
}

export function findApp(sandboxes: ApiSandbox[], directory: string): ApiApp | null {
  const sandboxId = directory.split("/")[0];
  if (!sandboxId) return null;
  const sandbox = findSandbox(sandboxes, sandboxId);
  if (!sandbox) return null;
  return sandbox.apps.find((a) => a.directory === directory) ?? null;
}

export function findPackage(sandboxes: ApiSandbox[], directory: string): ApiPackage | null {
  const sandboxId = directory.split("/")[0];
  if (!sandboxId) return null;
  const sandbox = findSandbox(sandboxes, sandboxId);
  if (!sandbox) return null;
  for (const app of sandbox.apps) {
    const pkg = app.workspacePackages.find((p) => p.directory === directory);
    if (pkg) return pkg;
  }
  return null;
}

export function resolveSelection(
  sandboxes: ApiSandbox[],
  directory: string,
): { sandbox: ApiSandbox | null; app: ApiApp | null; pkg: ApiPackage | null } {
  const sandboxId = directory.split("/")[0];
  if (!sandboxId) return { sandbox: null, app: null, pkg: null };
  const sandbox = findSandbox(sandboxes, sandboxId);
  if (!sandbox) return { sandbox: null, app: null, pkg: null };
  if (directory === sandboxId) return { sandbox, app: null, pkg: null };
  const appRoot = directory.split("/").slice(0, 2).join("/");
  const app = sandbox.apps.find((a) => a.directory === appRoot) ?? null;
  if (!app) return { sandbox, app: null, pkg: null };
  if (directory === appRoot) return { sandbox, app, pkg: null };
  const pkg = app.workspacePackages.find((p) => p.directory === directory) ?? null;
  return { sandbox, app, pkg };
}

export interface CreateSandboxOptions {
  framework: string;
  project?: string;
  onProgress?: (event: SandboxProgressEvent) => void;
  signal?: AbortSignal;
}

export interface CloneSandboxOptions {
  branch?: string;
  onProgress?: (event: SandboxProgressEvent) => void;
  signal?: AbortSignal;
  repoUrl?: string;
  defaultBranch?: string;
  isPrivate?: boolean;
  vpsConfirmToken?: string;
}

export interface UploadSandboxOptions {
  file: File;
  onProgress?: (event: SandboxProgressEvent) => void;
  signal?: AbortSignal;
}

export interface SandboxCreationResult {
  success: boolean;
  sandbox?: ApiSandbox;
  app?: ApiApp;
  installing?: boolean;
  error?: string;
  code?: string;
}

interface AppsListContextValue {
  sandboxes: ApiSandbox[];
  active: ApiActiveSelection;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  codeApiUrl: string;

  createSandbox: (name: string, options: CreateSandboxOptions) => Promise<SandboxCreationResult>;
  uploadSandbox: (name: string, options: UploadSandboxOptions) => Promise<SandboxCreationResult>;
  cloneSandbox: (
    provider: "github" | "gitlab" | "bitbucket",
    repoFullName: string,
    name: string,
    options?: CloneSandboxOptions,
  ) => Promise<SandboxCreationResult>;
  isCreatingSandbox: boolean;

  deleteSandbox: (sandboxId: string) => Promise<{ success: boolean; error?: string }>;
  isDeletingSandbox: boolean;
}

const AppsListContext = createContext<AppsListContextValue | null>(null);

export function useAppsList(): AppsListContextValue {
  const context = useContext(AppsListContext);
  if (!context) {
    throw new Error("useAppsList must be used within AppsListProvider");
  }
  return context;
}

export function useAppsListOptional(): AppsListContextValue | null {
  return useContext(AppsListContext);
}

interface AppsListProviderProps {
  children: ReactNode;
  serverDomain: string;
  securityTier?: "standard" | "web_locked" | "private_locked";
  serverStatus?: string | null;
}

function isVpsUnreachable(status?: string | null): boolean {
  return status === "upgrading" || status === "downgrading" ||
    status === "creating" || status === "provisioning" ||
    status === "hibernated" || status === "hibernating" || status === "waking" || status === "awaiting_unlock";
}

interface AppsCacheEntry {
  sandboxes: ApiSandbox[];
  active: ApiActiveSelection;
  timestamp: number;
}

const appsCache = new Map<string, AppsCacheEntry>();
const CACHE_TTL = 30 * 1000;

const EMPTY_ACTIVE: ApiActiveSelection = { sandbox: null, app: null };

// Top-level dispatch — Mock and Real are separate components, each with a
// stable hook graph. No conditional hooks anywhere in the body.
export function AppsListProvider(props: AppsListProviderProps) {
  return MOCK_MODE
    ? <MockAppsListProvider>{props.children}</MockAppsListProvider>
    : <RealAppsListProvider {...props}>{props.children}</RealAppsListProvider>;
}

function MockAppsListProvider({ children }: { children: ReactNode }) {
  const isEmpty =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("empty") === "1";
  const sandboxesForMock = isEmpty ? [] : mockSandboxes;

  const noop = useCallback(async (): Promise<SandboxCreationResult> => ({ success: false, error: "Mock mode" }), []);
  const noopDelete = useCallback(async () => ({ success: false, error: "Mock mode" }), []);

  const value: AppsListContextValue = {
    sandboxes: sandboxesForMock,
    active: { sandbox: sandboxesForMock[0]?.id ?? null, app: sandboxesForMock[0]?.apps[0]?.directory ?? null },
    isLoading: false,
    error: null,
    refresh: async () => {},
    codeApiUrl: "https://mock-code.ellul.ai",
    createSandbox: noop,
    uploadSandbox: noop,
    cloneSandbox: noop,
    isCreatingSandbox: false,
    deleteSandbox: noopDelete,
    isDeletingSandbox: false,
  };

  return (
    <AppsListContext.Provider value={value}>
      {children}
    </AppsListContext.Provider>
  );
}

function RealAppsListProvider({ children, serverDomain, securityTier: _securityTier, serverStatus }: AppsListProviderProps) {
  usePreviewLifecycleSync();

  const t = useTranslations("console.contexts.appsList");
  const { fetchWithCodeToken } = useCodeToken();
  const codeApiUrl = getCodeApiUrl(serverDomain);

  const cachedData = appsCache.get(codeApiUrl);
  const isCacheValid = cachedData && (Date.now() - cachedData.timestamp) < CACHE_TTL;

  const [sandboxes, setSandboxes] = useState<ApiSandbox[]>(isCacheValid ? cachedData.sandboxes : []);
  const [active, setActive] = useState<ApiActiveSelection>(isCacheValid ? cachedData.active : EMPTY_ACTIVE);
  const [isLoading, setIsLoading] = useState(!isCacheValid);
  const [error, setError] = useState<string | null>(null);
  const [isCreatingSandbox, setIsCreatingSandbox] = useState(false);
  const creatingRef = useRef(false);
  const [isDeletingSandbox, setIsDeletingSandbox] = useState(false);

  const hasInitializedRef = useRef(isCacheValid);
  const fetchSeqRef = useRef(0);

  const fetchSandboxes = useCallback(async (forceRefresh = false): Promise<ApiSandbox[]> => {
    if (isVpsUnreachable(serverStatus)) return sandboxes;

    if (!forceRefresh) {
      const cached = appsCache.get(codeApiUrl);
      if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        setSandboxes(cached.sandboxes);
        setActive(cached.active);
        setError(null);
        return cached.sandboxes;
      }
    }

    const seq = ++fetchSeqRef.current;
    try {
      const res = await fetchWithCodeToken(`${codeApiUrl}/api/apps`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch sandboxes");
      const data = await res.json() as { sandboxes?: ApiSandbox[]; active?: ApiActiveSelection };
      const fetchedSandboxes = data.sandboxes ?? [];
      const fetchedActive = data.active ?? EMPTY_ACTIVE;

      if (seq !== fetchSeqRef.current) return fetchedSandboxes;

      appsCache.set(codeApiUrl, {
        sandboxes: fetchedSandboxes,
        active: fetchedActive,
        timestamp: Date.now(),
      });

      setSandboxes(fetchedSandboxes);
      setActive(fetchedActive);
      setError(null);
      return fetchedSandboxes;
    } catch (e) {
      if (seq !== fetchSeqRef.current) return [];
      if (e instanceof AuthenticationError) {
        setError(t("authFailed"));
      } else {
        setError(t("cannotConnect"));
      }
      return [];
    }
  }, [codeApiUrl, fetchWithCodeToken, serverStatus, sandboxes, t]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    appsCache.delete(codeApiUrl);
    await fetchSandboxes(true);
    setIsLoading(false);
  }, [fetchSandboxes, codeApiUrl]);

  const createSandbox = useCallback(
    async (name: string, options: CreateSandboxOptions): Promise<SandboxCreationResult> => {
      if (creatingRef.current) return { success: false, error: t("creationInProgress") };
      creatingRef.current = true;
      setIsCreatingSandbox(true);
      try {
        const result = await createSandboxStream({
          endpoint: `${codeApiUrl}/api/apps/create`,
          fetcher: fetchWithCodeToken,
          payload: {
            name,
            type: "scaffold",
            framework: options.framework,
            ...(options.project ? { project: options.project } : {}),
          },
          onProgress: options.onProgress,
          signal: options.signal,
        });
        appsCache.delete(codeApiUrl);
        const fresh = await fetchSandboxes(true);
        const sandbox = fresh.find((s) => s.id === result.app.sandboxId);
        return {
          success: true,
          sandbox,
          app: result.app,
          installing: result.installing,
        };
      } catch (e) {
        if (e instanceof SandboxStreamError_) {
          return { success: false, error: e.message, code: e.code };
        }
        if (e instanceof DOMException && e.name === "AbortError") {
          return { success: false, error: t("cancelled"), code: "cancelled" };
        }
        return { success: false, error: e instanceof Error ? e.message : t("createFailed") };
      } finally {
        creatingRef.current = false;
        setIsCreatingSandbox(false);
      }
    },
    [codeApiUrl, fetchSandboxes, fetchWithCodeToken, t],
  );

  const uploadSandbox = useCallback(
    async (name: string, options: UploadSandboxOptions): Promise<SandboxCreationResult> => {
      if (creatingRef.current) return { success: false, error: t("creationInProgress") };
      creatingRef.current = true;
      setIsCreatingSandbox(true);
      try {
        const result = await uploadSandboxStream({
          endpoint: `${codeApiUrl}/api/apps/create`,
          fetcher: fetchWithCodeToken,
          name,
          file: options.file,
          onProgress: options.onProgress,
          signal: options.signal,
        });
        appsCache.delete(codeApiUrl);
        const fresh = await fetchSandboxes(true);
        const sandbox = fresh.find((s) => s.id === result.app.sandboxId);
        return {
          success: true,
          sandbox,
          app: result.app,
          installing: result.installing,
        };
      } catch (e) {
        if (e instanceof SandboxStreamError_) {
          return { success: false, error: e.message, code: e.code };
        }
        if (e instanceof DOMException && e.name === "AbortError") {
          return { success: false, error: t("cancelled"), code: "cancelled" };
        }
        return { success: false, error: e instanceof Error ? e.message : t("createFailed") };
      } finally {
        creatingRef.current = false;
        setIsCreatingSandbox(false);
      }
    },
    [codeApiUrl, fetchSandboxes, fetchWithCodeToken, t],
  );

  const cloneSandbox = useCallback(
    async (
      provider: "github" | "gitlab" | "bitbucket",
      repoFullName: string,
      name: string,
      options?: CloneSandboxOptions,
    ): Promise<SandboxCreationResult> => {
      setIsCreatingSandbox(true);
      try {
        const result = await createSandboxStream({
          endpoint: `${codeApiUrl}/api/apps/create`,
          fetcher: fetchWithCodeToken,
          payload: {
            name,
            type: "git",
            provider,
            repoFullName,
            ...(options?.branch ? { branch: options.branch } : {}),
            ...(options?.repoUrl ? { repoUrl: options.repoUrl } : {}),
            ...(options?.defaultBranch ? { defaultBranch: options.defaultBranch } : {}),
            ...(typeof options?.isPrivate === "boolean" ? { isPrivate: options.isPrivate } : {}),
            ...(options?.vpsConfirmToken ? { vpsConfirmToken: options.vpsConfirmToken } : {}),
          },
          onProgress: options?.onProgress,
          signal: options?.signal,
        });
        appsCache.delete(codeApiUrl);
        const fresh = await fetchSandboxes(true);
        const sandbox = fresh.find((s) => s.id === result.app.sandboxId);
        return {
          success: true,
          sandbox,
          app: result.app,
          installing: result.installing,
        };
      } catch (e) {
        if (e instanceof SandboxStreamError_) {
          return { success: false, error: e.message, code: e.code };
        }
        if (e instanceof DOMException && e.name === "AbortError") {
          return { success: false, error: t("cancelled"), code: "cancelled" };
        }
        return { success: false, error: e instanceof Error ? e.message : t("cloneFailed") };
      } finally {
        setIsCreatingSandbox(false);
      }
    },
    [codeApiUrl, fetchSandboxes, fetchWithCodeToken, t],
  );

  const deleteSandbox = useCallback(
    async (sandboxId: string): Promise<{ success: boolean; error?: string }> => {
      setIsDeletingSandbox(true);
      try {
        const res = await fetchWithCodeToken(`${codeApiUrl}/api/apps/${encodeURIComponent(sandboxId)}`, {
          method: "DELETE",
          credentials: "include",
        });
        if (!res.ok) {
          let errorMessage = t("deleteFailed");
          try {
            const data = await res.json() as { error?: string };
            if (data?.error) errorMessage = data.error;
          } catch {
            try {
              const text = await res.text();
              if (text) errorMessage = text.slice(0, 200);
            } catch { /* no body */ }
          }
          return { success: false, error: errorMessage };
        }

        setSandboxes((prev) => prev.filter((s) => s.id !== sandboxId));
        appsCache.delete(codeApiUrl);
        void fetchSandboxes(true);
        return { success: true };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : t("deleteFailed") };
      } finally {
        setIsDeletingSandbox(false);
      }
    },
    [codeApiUrl, fetchSandboxes, fetchWithCodeToken, t],
  );

  useEffect(() => {
    if (hasInitializedRef.current) {
      setIsLoading(false);
      return;
    }
    if (isVpsUnreachable(serverStatus)) return;
    hasInitializedRef.current = true;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverStatus]);

  const prevStatusRef = useRef(serverStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = serverStatus;
    if (serverStatus === "running" && prev && prev !== "running") {
      appsCache.delete(codeApiUrl);
      refresh();
    }
  }, [serverStatus, codeApiUrl, refresh]);

  const handleRealtimeMessage = useCallback((message: RealtimeMessage) => {
    if (message.type === "apps_changed") {
      appsCache.delete(codeApiUrl);
      fetchSandboxes(true);
    }
  }, [fetchSandboxes, codeApiUrl]);

  const { isConnected } = useRealtimeSubscribe(handleRealtimeMessage);

  const fallbackIntervalRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (!isConnected) {
      fallbackIntervalRef.current = setInterval(() => {
        if (document.visibilityState === "visible") {
          fetchSandboxes(true);
        }
      }, 60000);
    } else if (fallbackIntervalRef.current) {
      clearInterval(fallbackIntervalRef.current);
      fallbackIntervalRef.current = null;
    }
    return () => {
      if (fallbackIntervalRef.current) {
        clearInterval(fallbackIntervalRef.current);
      }
    };
  }, [isConnected, fetchSandboxes]);

  const value = useMemo<AppsListContextValue>(() => ({
    sandboxes,
    active,
    isLoading,
    error,
    refresh,
    codeApiUrl,
    createSandbox,
    uploadSandbox,
    cloneSandbox,
    isCreatingSandbox,
    deleteSandbox,
    isDeletingSandbox,
  }), [sandboxes, active, isLoading, error, refresh, codeApiUrl, createSandbox, uploadSandbox, cloneSandbox, isCreatingSandbox, deleteSandbox, isDeletingSandbox]);

  return (
    <AppsListContext.Provider value={value}>
      {children}
    </AppsListContext.Provider>
  );
}
