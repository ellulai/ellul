// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Key,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Check,
  Save,
  Lock,
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
  ChevronDown,
  Database,
  Pencil,
  X,
  Copy,
  Upload,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";
import { encryptSecret } from "@/lib/crypto";
import { useVpsBridge } from "@/lib/vps-bridge";
import { vpsFetch } from "@/lib/domains";

type SecurityTier = "standard" | "web_locked" | "private_locked";
type SecretEnvironment = "production" | "development";

// ── .env Parser (inline — browser can't import CLI package) ──

const ENV_KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

interface EnvParseEntry {
  key: string;
  value: string;
}

type EnvParseTranslator = {
  noEquals: (line: number) => string;
  invalidKey: (line: number, key: string) => string;
  unterminatedDouble: (line: number) => string;
  unterminatedSingle: (line: number) => string;
};

// Parse .env file content into key-value pairs.
function parseEnvContent(content: string, t: EnvParseTranslator): { entries: EnvParseEntry[]; warnings: string[] } {
  const entries: EnvParseEntry[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, number>();

  let input = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
  const lines = input.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const lineNum = i + 1;
    let line = lines[i]!.trim();
    i++;

    if (!line || line.startsWith('#')) continue;

    // Strip export prefix
    if (line.startsWith('export ') || line.startsWith('export\t')) {
      line = line.slice(7).trim();
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) { warnings.push(t.noEquals(lineNum)); continue; }

    const key = line.slice(0, eqIdx).trim();
    if (!ENV_KEY_REGEX.test(key)) { warnings.push(t.invalidKey(lineNum, key)); continue; }

    const rawValue = line.slice(eqIdx + 1);
    const vs = rawValue.trimStart();
    let value: string;

    if (vs.startsWith('"')) {
      // Double-quoted: escape sequences, multiline
      let result = '';
      let remaining = vs.slice(1);
      let li = i;
      let found = false;
      outer: for (;;) {
        for (let j = 0; j < remaining.length; j++) {
          if (remaining[j] === '\\' && j + 1 < remaining.length) {
            const next = remaining[j + 1]!;
            result += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next === '"' ? '"' : next === '\\' ? '\\' : '\\' + next;
            j++;
          } else if (remaining[j] === '"') {
            found = true;
            break outer;
          } else {
            result += remaining[j];
          }
        }
        if (li >= lines.length) break;
        result += '\n';
        remaining = lines[li]!;
        li++;
      }
      if (!found) { warnings.push(t.unterminatedDouble(lineNum)); continue; }
      value = result;
      i = li;
    } else if (vs.startsWith("'")) {
      // Single-quoted: literal, multiline
      let result = '';
      let remaining = vs.slice(1);
      let li = i;
      let found = false;
      for (;;) {
        const ci = remaining.indexOf("'");
        if (ci !== -1) { result += remaining.slice(0, ci); found = true; break; }
        result += remaining;
        if (li >= lines.length) break;
        result += '\n';
        remaining = lines[li]!;
        li++;
      }
      if (!found) { warnings.push(t.unterminatedSingle(lineNum)); continue; }
      value = result;
      i = li;
    } else {
      // Unquoted: strip inline comments, trim
      const hashIdx = rawValue.indexOf('#');
      if (hashIdx !== -1 && (rawValue[hashIdx - 1] === ' ' || rawValue[hashIdx - 1] === '\t' || hashIdx === 0)) {
        value = rawValue.slice(0, hashIdx).trim();
      } else {
        value = rawValue.trim();
      }
    }

    const existingIdx = seen.get(key);
    if (existingIdx !== undefined) {
      entries[existingIdx] = { key, value };
    } else {
      seen.set(key, entries.length);
      entries.push({ key, value });
    }
  }

  return { entries, warnings };
}

// Cannot be deleted from secrets UI — must detach via the originating feature.
const MANAGED_SECRETS = new Set(["DATABASE_URL"]);

interface SecretsManagerProps {
  serverId: string;
  tier: SecurityTier;
  serverDomain: string;
  sandboxId?: string;
}

interface PublicKeyResponse {
  publicKey: string;
  fingerprint: string;
  secretsMode: "self_managed" | "platform_managed";
}

interface CustomVariable {
  id: string;
  key: string;
  value: string;
  // True if this variable was loaded from VPS (already saved)
  persisted: boolean;
  // Whether this variable is encrypted (sensitive) or plaintext. Default: "sensitive"
  sensitivity: "sensitive" | "plain";
}

// ── Exposure Tracking Types ──

interface ExposureInfo {
  key_name: string;
  exposed_at: number;
  thread_id: string;
  hash_matches_current: boolean;
  kind: "secret" | "plain";
  acknowledged_at: number | null;
}

// Hook to fetch exposure tracking data for an app's secrets.
function useExposures(serverDomain: string, sandboxId: string) {
  return useQuery<ExposureInfo[]>({
    queryKey: ["exposures", serverDomain, sandboxId],
    queryFn: async () => {
      const res = await vpsFetch(
        serverDomain,
        `/_auth/secrets/exposures?sandboxId=${encodeURIComponent(sandboxId)}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) return [];
      const data = await res.json();
      return data.exposures || [];
    },
    staleTime: 30_000,
    retry: false,
  });
}

// SecretsManager: Encrypted environment variable management.
export function SecretsManager({ serverId, tier, serverDomain, sandboxId }: SecretsManagerProps) {
  if (!sandboxId) {
    // Secrets are sandbox-scoped; nothing to render without a sandbox.
    return null;
  }
  if (tier !== "standard") {
    return <SecretsBridge serverId={serverId} serverDomain={serverDomain} sandboxId={sandboxId} />;
  }
  return <SecretsDirect serverId={serverId} serverDomain={serverDomain} sandboxId={sandboxId} />;
}

// ── Shared hooks ──

function usePublicKey(serverId: string, serverDomain: string, fallbackError: string) {
  const isLocal = serverId === "local" && serverDomain.startsWith("localhost");
  return useQuery<PublicKeyResponse>({
    queryKey: ["publicKey", serverId],
    queryFn: async () => {
      if (isLocal) {
        const res = await vpsFetch(serverDomain, "/_auth/secrets/public-key");
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error || fallbackError);
        }
        return res.json() as Promise<PublicKeyResponse>;
      }
      const response = await api.api.servers[":id"]["public-key"].$get({
        param: { id: serverId },
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error((err as { error?: string }).error || fallbackError);
      }
      return response.json() as Promise<PublicKeyResponse>;
    },
    retry: false,
  });
}

// ── Bridge-based (web_locked) ──

function SecretsBridge({ serverId, serverDomain, sandboxId }: { serverId: string; serverDomain: string; sandboxId: string }) {
  const t = useTranslations("console.secrets");
  const { send } = useVpsBridge();
  const { data: publicKeyData, isLoading: loadingKey } = usePublicKey(serverId, serverDomain, t("errors.fetchPublicKey"));
  const [activeEnv, setActiveEnv] = useState<SecretEnvironment>("production");
  const { data: exposures } = useQuery<ExposureInfo[]>({
    queryKey: ["exposures", serverDomain, sandboxId],
    queryFn: async () => {
      const data = await send<{ exposures: ExposureInfo[] }>("secrets_exposures", { sandboxId });
      return data.exposures || [];
    },
    staleTime: 30_000,
    retry: false,
  });

  const [loadingNames, setLoadingNames] = useState(true);
  const [customVars, setCustomVars] = useState<CustomVariable[]>([]);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [secretToDelete, setSecretToDelete] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const initialLoadDone = useRef(false);
  const fetchNames = useCallback(async () => {
    if (!initialLoadDone.current) setLoadingNames(true);
    try {
      const result = await send<{ names: string[]; classifications?: Record<string, 'secret' | 'plain'> }>("list_secrets", { sandboxId, env: activeEnv });
      const classifications = result.classifications ?? {};
      setCustomVars(result.names.map(name => ({
        id: `saved-${name}`,
        key: name,
        value: "",
        persisted: true,
        sensitivity: classifications[name] === "plain" ? "plain" as const : "sensitive" as const,
      })));
    } catch (err) {
      console.warn("Failed to list secrets:", err);
    } finally {
      setLoadingNames(false);
      initialLoadDone.current = true;
    }
  }, [send, activeEnv]);

  useEffect(() => {
    fetchNames();
  }, [fetchNames]);

  const handleFetchValues = useCallback(async (): Promise<Record<string, string>> => {
    const result = await send<{ values: Record<string, string> }>("read_secret_values", { sandboxId, env: activeEnv });
    return result.values ?? {};
  }, [send, sandboxId, activeEnv]);

  const handleSaveOne = useCallback(async (name: string, value: string, sensitivity: "sensitive" | "plain") => {
    if (!publicKeyData?.publicKey) throw new Error(t("errors.publicKeyUnavailable"));
    const encrypted = await encryptSecret(publicKeyData.publicKey, value);
    await send("set_secret", {
      name,
      ...encrypted,
      sandboxId,
      env: activeEnv,
      kind: sensitivity === "plain" ? "plain" : "secret",
    });
  }, [send, publicKeyData, sandboxId, activeEnv, t]);

  const handleSaveAll = async () => {
    if (!publicKeyData?.publicKey) {
      setSaveError(t("errors.publicKeyUnavailable"));
      return;
    }
    setIsSaving(true);
    setSaveError(null);

    try {
      const toSave = customVars.filter(v => v.key && v.value && !v.persisted);
      if (toSave.length === 0) {
        setHasChanges(false);
        return;
      }

      for (const variable of toSave) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(variable.key)) {
          setSaveError(t("errors.invalidVariableName", { key: variable.key }));
          setIsSaving(false);
          return;
        }
      }

      for (const variable of toSave) {
        await handleSaveOne(variable.key, variable.value, variable.sensitivity);
      }

      await fetchNames();
      setHasChanges(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("errors.saveSecrets"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!secretToDelete) return;
    setIsDeleting(true);
    try {
      await send("delete_secret", { name: secretToDelete, sandboxId, env: activeEnv });
      setCustomVars(prev => prev.filter(v => v.key !== secretToDelete));
      setShowDeleteDialog(false);
      setSecretToDelete(null);
      await fetchNames();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("errors.deleteSecret"));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleEnvChange = (env: SecretEnvironment) => {
    setActiveEnv(env);
    setHasChanges(false);
    setSaveError(null);
    setSaveSuccess(false);
  };

  return (
    <SecretsUI
      publicKeyData={publicKeyData}
      isLoading={loadingKey || loadingNames}
      customVars={customVars}
      setCustomVars={setCustomVars}
      showDeleteDialog={showDeleteDialog}
      setShowDeleteDialog={setShowDeleteDialog}
      secretToDelete={secretToDelete}
      setSecretToDelete={setSecretToDelete}
      isSaving={isSaving}
      isDeleting={isDeleting}
      saveError={saveError}
      setSaveError={setSaveError}
      saveSuccess={saveSuccess}
      hasChanges={hasChanges}
      setHasChanges={setHasChanges}
      onSaveAll={handleSaveAll}
      onSaveOne={handleSaveOne}
      onFetchValues={handleFetchValues}
      onDelete={handleDelete}
      onRefresh={fetchNames}
      exposures={exposures}
      activeEnv={activeEnv}
      onEnvChange={handleEnvChange}
      onClassify={async (keyName, kind) => {
        await send("secrets_classify", { name: keyName, kind, sandboxId });
      }}
      onAcknowledge={async (keyName) => {
        await send("secrets_acknowledge", { name: keyName, sandboxId });
      }}
      onImportEnv={async (entries, env) => {
        if (!publicKeyData?.publicKey) throw new Error(t("errors.publicKeyUnavailable"));
        const secrets = [];
        for (const entry of entries) {
          const encrypted = await encryptSecret(publicKeyData.publicKey, entry.value);
          secrets.push({ name: entry.key, ...encrypted });
        }
        const result = await send<{ count?: number }>("secrets_bulk_set", {
          secrets,
          sandboxId,
          env,
        });
        await fetchNames();
        return result.count ?? entries.length;
      }}
      serverDomain={serverDomain}
      sandboxId={sandboxId}
    />
  );
}

// ── Direct fetch (standard) ──

function SecretsDirect({ serverId, serverDomain, sandboxId }: { serverId: string; serverDomain: string; sandboxId: string }) {
  const t = useTranslations("console.secrets");
  const sf = useCallback((path: string, init?: RequestInit) => vpsFetch(serverDomain, path, init), [serverDomain]);
  const { data: publicKeyData, isLoading: loadingKey } = usePublicKey(serverId, serverDomain, t("errors.fetchPublicKey"));
  const [activeEnv, setActiveEnv] = useState<SecretEnvironment>("production");
  const { data: exposures } = useExposures(serverDomain, sandboxId);

  const [loadingNames, setLoadingNames] = useState(true);
  const [customVars, setCustomVars] = useState<CustomVariable[]>([]);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [secretToDelete, setSecretToDelete] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const initialLoadDone = useRef(false);
  const fetchNames = useCallback(async () => {
    if (!initialLoadDone.current) setLoadingNames(true);
    try {
      const res = await sf(`/_auth/secrets?sandboxId=${encodeURIComponent(sandboxId)}&env=${activeEnv}`, {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const data = await res.json();
        const classifications: Record<string, string> = data.classifications ?? {};
        setCustomVars(data.names.map((name: string) => ({
          id: `saved-${name}`,
          key: name,
          value: "",
          persisted: true,
          sensitivity: classifications[name] === "plain" ? "plain" as const : "sensitive" as const,
        })));
      }
    } catch (err) {
      console.warn("Failed to list secrets:", err);
    } finally {
      setLoadingNames(false);
      initialLoadDone.current = true;
    }
  }, [sf, activeEnv]);

  useEffect(() => {
    fetchNames();
  }, [fetchNames]);

  const handleFetchValues = useCallback(async (): Promise<Record<string, string>> => {
    const res = await sf(`/_auth/secrets/values?sandboxId=${encodeURIComponent(sandboxId)}&env=${activeEnv}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(t("errors.readValues"));
    const data = await res.json();
    return data.values ?? {};
  }, [sf, sandboxId, activeEnv, t]);

  const handleSaveOne = useCallback(async (name: string, value: string, sensitivity: "sensitive" | "plain") => {
    if (!publicKeyData?.publicKey) throw new Error(t("errors.publicKeyUnavailable"));
    const encrypted = await encryptSecret(publicKeyData.publicKey, value);
    const res = await sf(`/_auth/secrets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        name,
        ...encrypted,
        sandboxId,
        env: activeEnv,
        kind: sensitivity === "plain" ? "plain" : "secret",
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || t("errors.saveSecret"));
    }
  }, [sf, publicKeyData, sandboxId, activeEnv, t]);

  const handleSaveAll = async () => {
    if (!publicKeyData?.publicKey) {
      setSaveError(t("errors.publicKeyUnavailable"));
      return;
    }
    setIsSaving(true);
    setSaveError(null);

    try {
      const toSave = customVars.filter(v => v.key && v.value && !v.persisted);
      if (toSave.length === 0) {
        setHasChanges(false);
        return;
      }

      for (const variable of toSave) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(variable.key)) {
          setSaveError(t("errors.invalidVariableName", { key: variable.key }));
          setIsSaving(false);
          return;
        }
      }

      for (const variable of toSave) {
        await handleSaveOne(variable.key, variable.value, variable.sensitivity);
      }

      await fetchNames();
      setHasChanges(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("errors.saveSecrets"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!secretToDelete) return;
    setIsDeleting(true);
    try {
      const res = await sf(`/_auth/secrets/${encodeURIComponent(secretToDelete)}?sandboxId=${encodeURIComponent(sandboxId)}&env=${activeEnv}`, {
        method: "DELETE",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(t("errors.deleteSecret"));
      setCustomVars(prev => prev.filter(v => v.key !== secretToDelete));
      setShowDeleteDialog(false);
      setSecretToDelete(null);
      await fetchNames();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("errors.deleteSecret"));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleEnvChange = (env: SecretEnvironment) => {
    setActiveEnv(env);
    setHasChanges(false);
    setSaveError(null);
    setSaveSuccess(false);
  };

  return (
    <SecretsUI
      publicKeyData={publicKeyData}
      isLoading={loadingKey || loadingNames}
      customVars={customVars}
      setCustomVars={setCustomVars}
      showDeleteDialog={showDeleteDialog}
      setShowDeleteDialog={setShowDeleteDialog}
      secretToDelete={secretToDelete}
      setSecretToDelete={setSecretToDelete}
      isSaving={isSaving}
      isDeleting={isDeleting}
      saveError={saveError}
      setSaveError={setSaveError}
      saveSuccess={saveSuccess}
      hasChanges={hasChanges}
      setHasChanges={setHasChanges}
      onSaveAll={handleSaveAll}
      onSaveOne={handleSaveOne}
      onFetchValues={handleFetchValues}
      onDelete={handleDelete}
      onRefresh={fetchNames}
      exposures={exposures}
      activeEnv={activeEnv}
      onEnvChange={handleEnvChange}
      onImportEnv={async (entries, env) => {
        if (!publicKeyData?.publicKey) throw new Error(t("errors.publicKeyUnavailable"));
        const secrets = [];
        for (const entry of entries) {
          const encrypted = await encryptSecret(publicKeyData.publicKey, entry.value);
          secrets.push({ name: entry.key, ...encrypted });
        }
        const res = await sf(`/_auth/secrets/bulk`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ secrets, sandboxId, env }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as { error?: string }).error || t("errors.importSecrets"));
        }
        const result = await res.json() as { count?: number };
        await fetchNames();
        return result.count ?? entries.length;
      }}
      serverDomain={serverDomain}
      sandboxId={sandboxId}
    />
  );
}

// ── Shared UI ──

interface SecretsUIProps {
  publicKeyData: PublicKeyResponse | undefined;
  isLoading: boolean;
  customVars: CustomVariable[];
  setCustomVars: React.Dispatch<React.SetStateAction<CustomVariable[]>>;
  showDeleteDialog: boolean;
  setShowDeleteDialog: (v: boolean) => void;
  secretToDelete: string | null;
  setSecretToDelete: (v: string | null) => void;
  isSaving: boolean;
  isDeleting: boolean;
  saveError: string | null;
  setSaveError: (v: string | null) => void;
  saveSuccess: boolean;
  hasChanges: boolean;
  setHasChanges: (v: boolean) => void;
  onSaveAll: () => Promise<void>;
  onSaveOne: (name: string, value: string, sensitivity: "sensitive" | "plain") => Promise<void>;
  onFetchValues: () => Promise<Record<string, string>>;
  onDelete: () => Promise<void>;
  onRefresh: () => Promise<void>;
  exposures?: ExposureInfo[];
  activeEnv?: SecretEnvironment;
  onEnvChange?: (env: SecretEnvironment) => void;
  onClassify?: (keyName: string, kind: "secret" | "plain") => Promise<void>;
  onAcknowledge?: (keyName: string) => Promise<void>;
  onImportEnv?: (entries: EnvParseEntry[], env: SecretEnvironment) => Promise<number>;
  serverDomain?: string;
  sandboxId?: string;
}

function SecretsUI({
  publicKeyData,
  isLoading,
  customVars,
  setCustomVars,
  showDeleteDialog,
  setShowDeleteDialog,
  secretToDelete,
  setSecretToDelete,
  isSaving,
  isDeleting,
  saveError,
  setSaveError,
  saveSuccess,
  hasChanges,
  setHasChanges,
  onSaveAll,
  onSaveOne,
  onFetchValues,
  onDelete,
  onRefresh,
  exposures,
  activeEnv = "production",
  onEnvChange,
  onClassify: onClassifyProp,
  onAcknowledge: onAcknowledgeProp,
  onImportEnv,
  serverDomain,
  sandboxId,
}: SecretsUIProps) {
  const t = useTranslations("console.secrets");
  const hasPublicKey = !!publicKeyData?.publicKey;
  const queryClient = useQueryClient();

  // ── Import .env state ──
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importContent, setImportContent] = useState("");
  const [importParsed, setImportParsed] = useState<EnvParseEntry[] | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Revealed values (fetched on demand) ──
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  const [valuesLoaded, setValuesLoaded] = useState(false);
  const [loadingValues, setLoadingValues] = useState(false);
  const [revealedRows, setRevealedRows] = useState<Set<string>>(new Set());

  // ── Per-row edit state (supports multiple concurrent edits) ──
  const [editingRows, setEditingRows] = useState<Set<string>>(new Set());
  const [editBuffers, setEditBuffers] = useState<Record<string, string>>({});
  const [savingRows, setSavingRows] = useState<Set<string>>(new Set());

  // ── Copy feedback ──
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Ref for persisted vars — stable access in callbacks before render-time computation
  const persistedVarsRef = useRef<CustomVariable[]>([]);

  // Reset revealed/edit state when env changes
  useEffect(() => {
    setRevealedValues({});
    setValuesLoaded(false);
    setRevealedRows(new Set());
    setEditingRows(new Set());
    setEditBuffers({});
    setCopiedKey(null);
  }, [activeEnv]);

  // Build exposure lookup map
  const exposureMap = new Map<string, ExposureInfo>();
  for (const exp of exposures ?? []) {
    exposureMap.set(exp.key_name, exp);
  }

  const handleClassify = async (keyName: string, kind: "secret" | "plain") => {
    if (onClassifyProp) {
      await onClassifyProp(keyName, kind);
      queryClient.invalidateQueries({ queryKey: ["exposures", serverDomain, sandboxId] });
      return;
    }
    if (!serverDomain || !sandboxId) return;
    try {
      await vpsFetch(serverDomain, `/_auth/secrets/classify`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ sandboxId, keyName, kind }),
      });
      queryClient.invalidateQueries({ queryKey: ["exposures", serverDomain, sandboxId] });
    } catch {}
  };

  const handleAcknowledge = async (keyName: string) => {
    if (onAcknowledgeProp) {
      await onAcknowledgeProp(keyName);
      queryClient.invalidateQueries({ queryKey: ["exposures", serverDomain, sandboxId] });
      return;
    }
    if (!serverDomain || !sandboxId) return;
    try {
      await vpsFetch(serverDomain, `/_auth/secrets/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ sandboxId, keyName }),
      });
      queryClient.invalidateQueries({ queryKey: ["exposures", serverDomain, sandboxId] });
    } catch {}
  };

  // ── Ensure values are loaded (shared helper) ──
  const ensureValuesLoaded = async (): Promise<Record<string, string> | null> => {
    if (valuesLoaded) return revealedValues;
    setLoadingValues(true);
    try {
      const vals = await onFetchValues();
      setRevealedValues(vals);
      setValuesLoaded(true);
      setLoadingValues(false);
      return vals;
    } catch {
      setSaveError(t("errors.loadValues"));
      setLoadingValues(false);
      return null;
    }
  };

  // ── Fetch and reveal a single secret value ──
  const handleReveal = async (id: string) => {
    if (revealedRows.has(id)) {
      setRevealedRows(prev => { const n = new Set(prev); n.delete(id); return n; });
      return;
    }
    const vals = await ensureValuesLoaded();
    if (!vals) return;
    setRevealedRows(prev => new Set(prev).add(id));
  };

  // ── Reveal / hide all secrets at once ──
  const handleRevealAll = async () => {
    const allCurrentlyRevealed = persistedVarsRef.current.length > 0 && persistedVarsRef.current.every(v => revealedRows.has(v.id));
    if (allCurrentlyRevealed) {
      setRevealedRows(new Set());
      return;
    }
    const vals = await ensureValuesLoaded();
    if (!vals) return;
    setRevealedRows(new Set(persistedVarsRef.current.map(v => v.id)));
  };

  // ── Enter edit mode for a persisted row (concurrent edits allowed) ──
  const handleStartEdit = async (variable: CustomVariable) => {
    const vals = await ensureValuesLoaded();
    if (!vals) return;
    setEditBuffers(prev => ({ ...prev, [variable.id]: vals[variable.key] ?? "" }));
    setEditingRows(prev => new Set(prev).add(variable.id));
  };

  // ── Save edited value for a single row ──
  const handleSaveEdit = async (variable: CustomVariable) => {
    const buffer = editBuffers[variable.id];
    if (buffer === undefined) return;
    setSavingRows(prev => new Set(prev).add(variable.id));
    setSaveError(null);
    try {
      await onSaveOne(variable.key, buffer, variable.sensitivity);
      // Update local revealed value
      setRevealedValues(prev => ({ ...prev, [variable.key]: buffer }));
      // Exit edit mode for this row
      setEditingRows(prev => { const n = new Set(prev); n.delete(variable.id); return n; });
      setEditBuffers(prev => { const n = { ...prev }; delete n[variable.id]; return n; });
      await onRefresh();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("errors.saveSecret"));
    } finally {
      setSavingRows(prev => { const n = new Set(prev); n.delete(variable.id); return n; });
    }
  };

  const handleCancelEdit = (id: string) => {
    setEditingRows(prev => { const n = new Set(prev); n.delete(id); return n; });
    setEditBuffers(prev => { const n = { ...prev }; delete n[id]; return n; });
  };

  const addCustomVariable = () => {
    setCustomVars(prev => [
      ...prev,
      { id: `new-${Date.now()}`, key: "", value: "", persisted: false, sensitivity: "sensitive" },
    ]);
    setHasChanges(true);
  };

  const updateCustomVariable = (id: string, field: "key" | "value", value: string) => {
    setCustomVars(prev =>
      prev.map(v => (v.id === id ? { ...v, [field]: value, persisted: false } : v))
    );
    setHasChanges(true);
    setSaveError(null);
  };

  const updateSensitivity = (id: string, sensitivity: "sensitive" | "plain") => {
    setCustomVars(prev =>
      prev.map(v => (v.id === id ? { ...v, sensitivity } : v))
    );
    setHasChanges(true);
  };

  const removeCustomVariable = (id: string) => {
    const variable = customVars.find(v => v.id === id);
    if (variable && MANAGED_SECRETS.has(variable.key)) return;
    if (variable && variable.persisted && variable.key) {
      setSecretToDelete(variable.key);
      setShowDeleteDialog(true);
    } else {
      setCustomVars(prev => prev.filter(v => v.id !== id));
    }
    setHasChanges(true);
  };

  const handleCopy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // Fallback: older browsers or non-secure context
      setSaveError(t("errors.clipboardUnavailable"));
    }
  };

  // ── Import .env handlers ──

  const handleImportContentChange = (text: string) => {
    setImportContent(text);
    setImportResult(null);
    if (!text.trim()) {
      setImportParsed(null);
      setImportWarnings([]);
      return;
    }
    const result = parseEnvContent(text, {
      noEquals: (line) => t("envParse.noEquals", { line }),
      invalidKey: (line, key) => t("envParse.invalidKey", { line, key }),
      unterminatedDouble: (line) => t("envParse.unterminatedDouble", { line }),
      unterminatedSingle: (line) => t("envParse.unterminatedSingle", { line }),
    });
    setImportParsed(result.entries);
    setImportWarnings(result.warnings);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      handleImportContentChange(text);
    };
    reader.readAsText(file);

    // Reset input so same file can be re-selected
    e.target.value = "";
  };

  const handleImportSubmit = async () => {
    if (!importParsed?.length || !onImportEnv) return;
    setIsImporting(true);
    setSaveError(null);
    try {
      const count = await onImportEnv(importParsed, activeEnv);
      setImportResult(t("secretsImportedSuccess", { count }));
      setImportContent("");
      setImportParsed(null);
      setImportWarnings([]);
      // Close dialog after brief delay to show success
      setTimeout(() => {
        setShowImportDialog(false);
        setImportResult(null);
      }, 1500);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("errors.importSecrets"));
    } finally {
      setIsImporting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner size="lg" />
      </div>
    );
  }

  const managed = customVars.filter(v => v.persisted && MANAGED_SECRETS.has(v.key));
  const userVars = customVars.filter(v => !v.persisted || !MANAGED_SECRETS.has(v.key));
  const persistedVars = userVars.filter(v => v.persisted);
  const newVars = userVars.filter(v => !v.persisted);
  persistedVarsRef.current = persistedVars;

  // Compute reveal-all state (used by header toggle)
  const allRevealed = persistedVars.length > 0 && persistedVars.every(v => revealedRows.has(v.id));

  return (
    <>
      <form autoComplete="off" onSubmit={(e) => e.preventDefault()} className="space-y-4">
        {/* Environment Tabs */}
        {onEnvChange && (
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-cream/[0.03] border border-cream/[0.06]">
            {(["production", "development"] as const).map((env) => (
              <button
                key={env}
                type="button"
                onClick={() => onEnvChange(env)}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  activeEnv === env
                    ? "bg-cream/[0.08] text-cream shadow-sm"
                    : "text-cream/45 hover:text-cream/75"
                }`}
              >
                {env === "production" ? t("envProduction") : t("envDevelopment")}
              </button>
            ))}
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-cream/60">
            <Lock className="h-3 w-3" />
            <span>{activeEnv === "development" ? t("envDevelopmentLabel") : t("envProductionLabel")}</span>
          </div>
          <div className="flex items-center gap-2">
            {persistedVars.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRevealAll}
                disabled={loadingValues}
                className="h-8 text-xs border-border bg-secondary/30 hover:bg-cream/[0.06]"
              >
                {loadingValues ? (
                  <Spinner size="xs" className="mr-1.5" />
                ) : allRevealed ? (
                  <EyeOff className="h-3.5 w-3.5 mr-1.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5 mr-1.5" />
                )}
                {allRevealed ? t("hideAll") : t("revealAll")}
              </Button>
            )}
            {onImportEnv && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowImportDialog(true)}
                disabled={!hasPublicKey}
                className="h-8 text-xs border-border bg-secondary/30 hover:bg-cream/[0.06]"
              >
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                {t("importEnv")}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={addCustomVariable}
              disabled={!hasPublicKey}
              className="h-8 text-xs border-border bg-secondary/30 hover:bg-cream/[0.06]"
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              {t("addVariable")}
            </Button>
          </div>
        </div>

        {/* Managed secrets (DATABASE_URL etc.) — pinned at top, non-deletable */}
        {managed.length > 0 && (
          <div className="space-y-1.5">
            {managed.map((variable) => (
              <div key={variable.id} className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-sodium/15 bg-sodium/[0.03]">
                <div className="w-7 h-7 rounded-md bg-sodium/10 border border-sodium/20 flex items-center justify-center shrink-0">
                  <Database className="h-3.5 w-3.5 text-sodium" />
                </div>
                <div className="flex-1 min-w-0">
                  <code className="text-xs font-mono font-medium text-cream">{variable.key}</code>
                  <p className="text-[10px] text-cream/45 mt-0.5">{t("managedByIntegrationsHint")}</p>
                </div>
                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border text-sodium/70 border-sodium/20">
                  {t("managedByIntegrations")}
                </span>
              </div>
            ))}
            <p className="text-[10px] text-cream/45 px-1">
              {t("managedByIntegrationsNote")}
            </p>
          </div>
        )}

        {/* Empty state */}
        {customVars.length === 0 && (
          <div className="text-center py-8 border border-dashed border-border rounded-lg">
            <Key className="h-8 w-8 mx-auto mb-2 text-cream/45" />
            <p className="text-sm text-cream/60">{t("noEnvVars")}</p>
            <p className="text-xs text-cream/45 mt-1">{t("noEnvVarsHint")}</p>
          </div>
        )}

        {/* Persisted Variables — Vercel-style rows */}
        {persistedVars.length > 0 && (
          <div className="rounded-lg border border-border overflow-hidden">
            {persistedVars.map((variable, idx) => {
              const exposure = exposureMap.get(variable.key);
              const needsRotation = exposure && exposure.kind === "secret" && exposure.hash_matches_current && !exposure.acknowledged_at;
              const isEditing = editingRows.has(variable.id);
              const isRevealed = revealedRows.has(variable.id);
              const revealedValue = revealedValues[variable.key];
              const isSavingThis = savingRows.has(variable.id);
              const editValue = editBuffers[variable.id] ?? "";
              const isCopied = copiedKey === variable.key;

              return (
                <div key={variable.id}>
                  <div
                    className={`px-3 py-3 ${
                      idx > 0 ? "border-t border-border" : ""
                    } ${needsRotation ? "bg-terra/[0.03]" : "bg-card/20"}`}
                  >
                    {isEditing ? (
                      // ── Edit mode: full-width input with save/cancel ──
                      <div className="space-y-2">
                        <code className="text-xs font-mono font-medium text-cream">{variable.key}</code>
                        <div className="flex items-center gap-2">
                          <Input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditBuffers(prev => ({ ...prev, [variable.id]: e.target.value }))}
                            autoFocus
                            autoComplete="off"
                            data-1p-ignore
                            data-lpignore="true"
                            className="bg-card/40 border-border text-cream font-mono text-xs h-8 flex-1"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSaveEdit(variable);
                              if (e.key === "Escape") handleCancelEdit(variable.id);
                            }}
                          />
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => handleSaveEdit(variable)}
                            disabled={isSavingThis || !editValue}
                            className="h-8 text-xs bg-sodium hover:bg-sodium px-3"
                          >
                            {isSavingThis ? <Spinner size="xs" delay={300} /> : t("save")}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => handleCancelEdit(variable.id)}
                            className="h-8 text-xs text-cream/60 hover:text-cream px-2"
                          >
                            {t("cancel")}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      // ── View mode: key + value + actions ──
                      <div className="flex items-center gap-3">
                        {/* Key name — responsive: min-width with truncate on mobile, break-all on desktop */}
                        <div className="min-w-[80px] max-w-[120px] sm:max-w-[180px] shrink-0">
                          <code className="text-xs font-mono font-medium text-cream break-all leading-tight">{variable.key}</code>
                        </div>

                        {/* Value area */}
                        <div className="flex-1 min-w-0 overflow-hidden">
                          {isRevealed && revealedValue !== undefined ? (
                            <code className="text-xs font-mono text-cream/75 break-all line-clamp-2">{revealedValue}</code>
                          ) : (
                            <span className="text-xs text-cream/45 tracking-wider select-none">••••••••••••</span>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1 shrink-0">
                          {/* Sensitivity badge — hidden on smallest screens */}
                          <span className={`hidden sm:inline-block text-[10px] px-1.5 py-0.5 rounded border ${
                            variable.sensitivity === "plain"
                              ? "text-cream/60 border-cream/[0.06]"
                              : "text-sodium/70 border-sodium/20"
                          }`}>
                            {variable.sensitivity === "plain" ? t("sensitivityLabel.plain") : t("sensitivityLabel.secret")}
                          </span>

                          {/* Exposure badge — hidden on smallest screens */}
                          <div className="hidden sm:flex">
                            {exposure ? (
                              <ExposureBadge
                                exposure={exposure}
                                onClassify={(kind) => handleClassify(variable.key, kind)}
                                onAcknowledge={() => handleAcknowledge(variable.key)}
                              />
                            ) : (
                              <div className="flex items-center" title={t("exposureBadge.notExposed")}>
                                <ShieldCheck className="h-3.5 w-3.5 text-sodium/50" />
                              </div>
                            )}
                          </div>

                          {/* Reveal */}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-cream/45 hover:text-cream"
                            onClick={() => handleReveal(variable.id)}
                            disabled={loadingValues}
                            title={isRevealed ? t("actions.hideValue") : t("actions.revealValue")}
                          >
                            {loadingValues ? (
                              <Spinner size="xs" />
                            ) : isRevealed ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </Button>

                          {/* Copy with feedback */}
                          {isRevealed && revealedValue !== undefined && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={`h-7 w-7 ${isCopied ? "text-sodium" : "text-cream/45 hover:text-cream"}`}
                              onClick={() => handleCopy(revealedValue, variable.key)}
                              title={isCopied ? t("copiedExclaim") : t("actions.copyValue")}
                            >
                              {isCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                            </Button>
                          )}

                          {/* Edit */}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-cream/45 hover:text-cream"
                            onClick={() => handleStartEdit(variable)}
                            disabled={loadingValues}
                            title={t("actions.editValue")}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>

                          {/* Delete */}
                          {!MANAGED_SECRETS.has(variable.key) && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-cream/45 hover:text-terra hover:bg-terra/10"
                              onClick={() => removeCustomVariable(variable.id)}
                              title={t("actions.deleteAction")}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Rotation warning */}
                  {needsRotation && !isEditing && (
                    <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] text-terra/80 bg-terra/5 border-t border-terra/20">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      <span>{t("rotation.warning")}</span>
                      <button
                        type="button"
                        onClick={() => handleAcknowledge(variable.key)}
                        className="ml-auto text-cream/60 hover:text-cream underline"
                      >
                        {t("rotation.dismiss")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* New Variables — editable key + value */}
        {newVars.length > 0 && (
          <div className="space-y-2">
            {newVars.length > 0 && persistedVars.length > 0 && (
              <p className="text-[10px] text-cream/45 uppercase tracking-wider font-medium pt-2">{t("newVariables")}</p>
            )}
            {newVars.map((variable) => (
              <div key={variable.id} className="flex items-center gap-2 p-3 rounded-lg border border-cream/[0.04] bg-cream/[0.01]">
                <Input
                  placeholder={t("keyPlaceholder")}
                  value={variable.key}
                  onChange={(e) => updateCustomVariable(variable.id, "key", e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
                  autoComplete="new-password"
                  data-1p-ignore
                  data-lpignore="true"
                  className="w-32 sm:w-40 bg-card/40 border-border text-cream font-mono text-xs h-9"
                />
                <div className="flex-1 relative">
                  <Input
                    type="text"
                    placeholder={t("valuePlaceholder")}
                    value={variable.value}
                    onChange={(e) => updateCustomVariable(variable.id, "value", e.target.value)}
                    autoComplete="off"
                    data-1p-ignore
                    data-lpignore="true"
                    data-form-type="other"
                    className="bg-card/40 border-border text-cream font-mono text-xs h-9"
                    style={(variable.sensitivity === "sensitive" && variable.value) ? { WebkitTextSecurity: 'disc' } as React.CSSProperties : undefined}
                  />
                </div>
                <SensitivityDropdown
                  value={variable.sensitivity}
                  onChange={(v) => updateSensitivity(variable.id, v)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 h-9 w-9 text-cream/60 hover:text-terra hover:bg-terra/10"
                  onClick={() => removeCustomVariable(variable.id)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Save Button — only for new variables */}
        {hasPublicKey && newVars.length > 0 && (
          <div className="flex items-center justify-between pt-2">
            <div>
              {saveError && <p className="text-xs text-terra">{saveError}</p>}
              {saveSuccess && (
                <p className="text-xs text-sodium flex items-center gap-1">
                  <Check className="h-3 w-3" />
                  {t("savedSuccessfully")}
                </p>
              )}
            </div>
            <Button
              onClick={onSaveAll}
              disabled={isSaving || !hasChanges}
              size="sm"
              className="bg-sodium hover:bg-sodium"
            >
              {isSaving ? (
                <>
                  <Spinner size="sm" delay={300} className="mr-2" />
                  {t("saving")}
                </>
              ) : (
                <>
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                  {t("saveChanges")}
                </>
              )}
            </Button>
          </div>
        )}

        {/* Error for persisted row edits (no new vars) */}
        {saveError && newVars.length === 0 && (
          <p className="text-xs text-terra">{saveError}</p>
        )}
      </form>

      {/* Delete Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="bg-card border-border text-cream">
          <DialogHeader>
            <DialogTitle className="text-terra">{t("deleteSecretTitle")}</DialogTitle>
            <DialogDescription className="text-cream/60">
              {t.rich("deleteSecretDescription", {
                name: secretToDelete ?? "",
                strong: (chunks) => <strong className="text-cream">{chunks}</strong>,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setShowDeleteDialog(false);
                setSecretToDelete(null);
              }}
              className="text-cream/60 hover:text-cream"
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={onDelete}
              disabled={isDeleting}
              className="bg-terra hover:bg-terra"
            >
              {isDeleting ? t("deleting") : t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import .env Dialog */}
      <Dialog open={showImportDialog} onOpenChange={(open) => {
        setShowImportDialog(open);
        if (!open) {
          setImportContent("");
          setImportParsed(null);
          setImportWarnings([]);
          setImportResult(null);
        }
      }}>
        <DialogContent className="bg-card border-border text-cream max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              {t("importDialogTitle")}
            </DialogTitle>
            <DialogDescription className="text-cream/60">
              {t("importDialogDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {/* File upload */}
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".env,.env.*,.txt"
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                className="w-full h-9 text-xs border-dashed border-cream/[0.1] bg-cream/[0.02] hover:bg-cream/[0.04] text-cream/60"
              >
                <Upload className="h-3.5 w-3.5 mr-2" />
                {t("chooseEnvFile")}
              </Button>
            </div>

            <div className="text-center text-[10px] text-cream/45 uppercase tracking-wider">{t("orPasteBelow")}</div>

            {/* Text area for paste */}
            <textarea
              value={importContent}
              onChange={(e) => handleImportContentChange(e.target.value)}
              placeholder={t("importTextareaPlaceholder")}
              spellCheck={false}
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              className="w-full h-40 px-3 py-2 rounded-lg bg-black/30 border border-cream/[0.08] text-cream font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-sodium/50 placeholder:text-cream/35"
            />

            {/* Parse preview */}
            {importParsed && importParsed.length > 0 && (
              <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-3 space-y-1.5">
                <p className="text-xs text-cream/60">
                  {t("variablesDetected", { count: importParsed.length })}
                  <span className="text-cream/45 ml-1">
                    → {activeEnv === "production" ? t("envProduction") : t("envDevelopment")}
                  </span>
                </p>
                <div className="max-h-24 overflow-y-auto space-y-0.5">
                  {importParsed.map((entry) => (
                    <div key={entry.key} className="flex items-center gap-2 text-[11px]">
                      <code className="text-sodium/80 font-mono">{entry.key}</code>
                      <span className="text-cream/35">=</span>
                      <span className="text-cream/45 truncate">
                        {entry.value.length <= 4 ? "****" : entry.value.slice(0, 3) + "***"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Warnings */}
            {importWarnings.length > 0 && (
              <div className="rounded-lg border border-sodium/20 bg-sodium/[0.03] p-2.5">
                <p className="text-[11px] text-sodium/80 font-medium mb-1">{t("warnings")}</p>
                {importWarnings.map((w, i) => (
                  <p key={i} className="text-[10px] text-sodium/60">{w}</p>
                ))}
              </div>
            )}

            {/* Success message */}
            {importResult && (
              <p className="text-xs text-sodium flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5" />
                {importResult}
              </p>
            )}

            {/* Error */}
            {saveError && showImportDialog && (
              <p className="text-xs text-terra">{saveError}</p>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setShowImportDialog(false);
                setImportContent("");
                setImportParsed(null);
                setImportWarnings([]);
                setImportResult(null);
              }}
              className="text-cream/60 hover:text-cream"
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={handleImportSubmit}
              disabled={isImporting || !importParsed?.length}
              className="bg-sodium hover:bg-sodium"
            >
              {isImporting ? (
                <>
                  <Spinner size="sm" delay={300} className="mr-2" />
                  {t("encrypting")}
                </>
              ) : (
                <>
                  <Lock className="h-3.5 w-3.5 mr-1.5" />
                  {t("importSecretsCount", { count: importParsed?.length ?? 0 })}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Sensitivity Dropdown ──

function SensitivityDropdown({
  value,
  onChange,
}: {
  value: "sensitive" | "plain";
  onChange: (v: "sensitive" | "plain") => void;
}) {
  const t = useTranslations("console.secrets");
  const SENSITIVITY_OPTIONS: { value: "sensitive" | "plain"; label: string }[] = [
    { value: "sensitive", label: t("sensitivityLabel.sensitive") },
    { value: "plain", label: t("sensitivityLabel.plain") },
  ];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const current = SENSITIVITY_OPTIONS.find((o) => o.value === value) ?? SENSITIVITY_OPTIONS[0]!;

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] border border-cream/[0.1] rounded-md px-2 py-1.5 text-cream/75 hover:border-cream/[0.2] hover:bg-cream/[0.03] transition-colors focus:outline-none focus:ring-1 focus:ring-sodium/50 w-[90px] justify-between h-9"
      >
        <span>{current.label}</span>
        <ChevronDown className={`h-2.5 w-2.5 text-cream/45 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-full bg-card border border-cream/[0.08] rounded-lg shadow-2xl z-50 py-1 backdrop-blur-xl">
          {SENSITIVITY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className="flex items-center justify-between w-full px-3 py-1.5 text-[11px] text-left hover:bg-cream/[0.06] transition-colors text-cream/75"
            >
              <span>{option.label}</span>
              {option.value === value && <Check className="h-3 w-3 text-sodium" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Exposure Badge ──

function ExposureBadge({
  exposure,
  onClassify,
  onAcknowledge,
}: {
  exposure: ExposureInfo;
  onClassify: (kind: "secret" | "plain") => void;
  onAcknowledge: () => void;
}) {
  const t = useTranslations("console.secrets");
  const [menuOpen, setMenuOpen] = useState(false);

  const isExposed = exposure.hash_matches_current;
  const isAcknowledged = !!exposure.acknowledged_at;
  const isPlain = exposure.kind === "plain";

  // Plain vars: no rotation concern
  if (isPlain) {
    return (
      <div className="shrink-0 relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center gap-1 text-[10px] text-cream/45 hover:text-cream/75 border border-cream/[0.06] rounded px-1.5 py-0.5"
          title={t("exposureBadge.publicTitle")}
        >
          <span>{t("exposureBadge.public")}</span>
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
        {menuOpen && (
          <ClassifyMenu
            current="plain"
            onClassify={(k) => { onClassify(k); setMenuOpen(false); }}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>
    );
  }

  // Secret, agent has NOT seen it OR value changed since exposure
  if (!isExposed) {
    return (
      <div className="shrink-0 relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center gap-1 text-[10px] text-sodium/70 hover:text-sodium border border-sodium/20 rounded px-1.5 py-0.5"
          title={exposure.exposed_at ? t("exposureBadge.rotatedTitle") : t("exposureBadge.notSeenTitle")}
        >
          <ShieldCheck className="h-3 w-3" />
          <span>{t("exposureBadge.safe")}</span>
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
        {menuOpen && (
          <ClassifyMenu
            current="secret"
            onClassify={(k) => { onClassify(k); setMenuOpen(false); }}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>
    );
  }

  // Secret, agent HAS seen current value, acknowledged
  if (isAcknowledged) {
    return (
      <div className="shrink-0 relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center gap-1 text-[10px] text-sodium/70 hover:text-sodium border border-sodium/20 rounded px-1.5 py-0.5"
          title={t("exposureBadge.acknowledgedTitle")}
        >
          <ShieldAlert className="h-3 w-3" />
          <span>{t("exposureBadge.seen")}</span>
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
        {menuOpen && (
          <ClassifyMenu
            current="secret"
            onClassify={(k) => { onClassify(k); setMenuOpen(false); }}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>
    );
  }

  // Secret, agent HAS seen current value, NOT acknowledged — needs rotation
  return (
    <div className="shrink-0 relative">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-terra hover:text-terra border border-terra/30 bg-terra/10 rounded px-1.5 py-0.5"
        title={t("exposureBadge.rotateTitle")}
      >
        <ShieldAlert className="h-3 w-3" />
        <span>{t("exposureBadge.rotate")}</span>
        <ChevronDown className="h-2.5 w-2.5" />
      </button>
      {menuOpen && (
        <ClassifyMenu
          current="secret"
          showAcknowledge
          onClassify={(k) => { onClassify(k); setMenuOpen(false); }}
          onAcknowledge={() => { onAcknowledge(); setMenuOpen(false); }}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}

function ClassifyMenu({
  current,
  showAcknowledge,
  onClassify,
  onAcknowledge,
  onClose,
}: {
  current: "secret" | "plain";
  showAcknowledge?: boolean;
  onClassify: (kind: "secret" | "plain") => void;
  onAcknowledge?: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("console.secrets");
  useEffect(() => {
    const handleClick = () => onClose();
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    setTimeout(() => document.addEventListener("mousedown", handleClick), 0);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  return (
    <div
      className="absolute right-0 top-full mt-1 w-40 bg-card border border-cream/[0.08] rounded-lg shadow-2xl z-50 py-1 backdrop-blur-xl"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => onClassify("secret")}
        className="flex items-center justify-between w-full px-3 py-1.5 text-xs text-left hover:bg-cream/[0.06] text-cream/75"
      >
        <span>{t("classifyMenu.secret")}</span>
        {current === "secret" && <Check className="h-3 w-3 text-sodium" />}
      </button>
      <button
        type="button"
        onClick={() => onClassify("plain")}
        className="flex items-center justify-between w-full px-3 py-1.5 text-xs text-left hover:bg-cream/[0.06] text-cream/75"
      >
        <span>{t("classifyMenu.plain")}</span>
        {current === "plain" && <Check className="h-3 w-3 text-sodium" />}
      </button>
      {showAcknowledge && onAcknowledge && (
        <>
          <div className="border-t border-cream/[0.06] my-1" />
          <button
            type="button"
            onClick={onAcknowledge}
            className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-left hover:bg-cream/[0.06] text-sodium"
          >
            <Check className="h-3 w-3" />
            <span>{t("classifyMenu.acknowledge")}</span>
          </button>
        </>
      )}
    </div>
  );
}
