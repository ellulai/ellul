// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  Key,

  Fingerprint,
  Trash2,
  Plus,
  Shield,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useVpsBridge } from "@/lib/vps-bridge";
import { vpsFetch } from "@/lib/domains";

type SecurityTier = "standard" | "web_locked" | "private_locked";

interface SshKey {
  id: string;
  fingerprint: string;
  name: string;
  addedAt: string;
  addedVia: string;
}

interface SshKeysManagerProps {
  tier: SecurityTier;
  serverDomain: string;
  serverIp: string;
  initialKeys: SshKey[];
  onKeysChange?: () => void;
}

// SshKeysManager - Unified SSH key management for all tiers
export function SshKeysManager({
  tier,
  serverDomain,
  initialKeys,
  onKeysChange,
}: SshKeysManagerProps) {
  if (tier !== "standard") {
    // VpsBridgeProvider is provided at top level in MobileDashboardLayout
    return <SshKeysBridge initialKeys={initialKeys} onKeysChange={onKeysChange} />;
  }

  // Standard tier - direct fetch with JWT cookie
  return (
    <SshKeysDirect
      serverDomain={serverDomain}
      initialKeys={initialKeys}
      onKeysChange={onKeysChange}
    />
  );
}

// Standard tier - direct fetch with JWT cookie
function SshKeysDirect({
  serverDomain,
  initialKeys,
  onKeysChange,
}: {
  serverDomain: string;
  initialKeys: SshKey[];
  onKeysChange?: () => void;
}) {
  const t = useTranslations("console.sshKeys");
  const [keys, setKeys] = useState<SshKey[]>(initialKeys);
  const [loading, setLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);

  const sf = useCallback((path: string, init?: RequestInit) => vpsFetch(serverDomain, path, init), [serverDomain]);

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await sf(`/_auth/api/keys`);
      if (res.ok) {
        const data = await res.json();
        setKeys(
          data.keys.map((k: { fingerprint: string; name: string }) => ({
            id: k.fingerprint,
            fingerprint: k.fingerprint,
            name: k.name,
            addedAt: "",
            addedVia: "vps",
          }))
        );
      }
    } catch (err) {
      console.log("Could not fetch keys:", err);
    } finally {
      setLoading(false);
    }
  }, [sf]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleAddKey = async () => {
    if (!newKeyValue.trim()) {
      setError(t("publicKeyRequired"));
      return;
    }

    setIsAdding(true);
    setError(null);

    try {
      const res = await sf(`/_auth/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newKeyName.trim() || t("defaultKeyName"),
          publicKey: newKeyValue.trim(),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? t("addFailed"));
      }

      const result = await res.json();

      setKeys((prev) => [
        ...prev,
        {
          id: result.fingerprint,
          fingerprint: result.fingerprint,
          name: newKeyName.trim() || t("defaultKeyName"),
          addedAt: new Date().toISOString(),
          addedVia: "dashboard",
        },
      ]);

      setNewKeyName("");
      setNewKeyValue("");
      setShowAddForm(false);
      onKeysChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("addFailed"));
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemoveKey = async (fingerprint: string) => {
    setRemovingKey(fingerprint);
    try {
      const res = await sf(
        `/_auth/keys/${encodeURIComponent(fingerprint)}`,
        { method: "DELETE" },
      );

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? t("removeFailed"));
      }

      setKeys((prev) => prev.filter((k) => k.fingerprint !== fingerprint));
      onKeysChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("removeFailed"));
    } finally {
      setRemovingKey(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-sodium" />
          <p className="text-sm font-medium text-cream/75">{t("title")}</p>
        </div>
        {loading && <Spinner size="xs" color="muted" />}
      </div>

      {keys.length > 0 && (
        <div className="space-y-2 max-h-40 overflow-y-auto">
          {keys.map((key) => (
            <div
              key={key.fingerprint}
              className="flex items-center justify-between rounded-md bg-cream/5 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-cream/75 truncate">
                  {key.name}
                </div>
                <code className="text-[10px] text-cream/60 truncate block">
                  {key.fingerprint}
                </code>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-terra hover:text-terra hover:bg-terra/10 h-6 px-2 text-xs ml-2"
                onClick={() => handleRemoveKey(key.fingerprint)}
                disabled={removingKey === key.fingerprint}
              >
                {removingKey === key.fingerprint ? (
                  <Spinner size="xs" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
              </Button>
            </div>
          ))}
        </div>
      )}

      {keys.length === 0 && !showAddForm && (
        <p className="text-xs text-cream/60">
          {t("noKeysHintStandard")}
        </p>
      )}

      {error && <p className="text-xs text-terra">{error}</p>}

      {showAddForm ? (
        <div className="space-y-2 rounded-md bg-cream/5 p-3">
          <Input
            placeholder={t("keyNamePlaceholder")}
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            className="h-8 text-xs bg-card/20 border-border"
          />
          <Textarea
            placeholder={t("keyPlaceholder")}
            value={newKeyValue}
            onChange={(e) => {
              setNewKeyValue(e.target.value);
              setError(null);
            }}
            className="min-h-[60px] text-xs font-mono bg-card/20 border-border"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 text-xs bg-sodium hover:bg-sodium"
              onClick={handleAddKey}
              disabled={isAdding || !newKeyValue.trim()}
            >
              {isAdding && <Spinner size="xs" className="mr-1" />}
              {t("addKey")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setShowAddForm(false);
                setNewKeyName("");
                setNewKeyValue("");
                setError(null);
              }}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="w-full h-7 text-xs border-sodium/30 text-sodium hover:bg-sodium/10"
          onClick={() => setShowAddForm(true)}
        >
          <Plus className="h-3 w-3 mr-1" />
          {t("addSshKey")}
        </Button>
      )}

      <p className="text-[10px] text-cream/45">
        <Shield className="h-3 w-3 inline mr-1" />
        {t("footerStandard")}
      </p>
    </div>
  );
}

// Web Locked tier - VPS bridge with passkey auth
function SshKeysBridge({
  initialKeys,
  onKeysChange,
}: {
  initialKeys: SshKey[];
  onKeysChange?: () => void;
}) {
  const t = useTranslations("console.sshKeys");
  const { ready, error: bridgeError, send } = useVpsBridge();
  const [keys, setKeys] = useState<SshKey[]>(initialKeys);
  const [loading, setLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [removingKey, setRemovingKey] = useState<string | null>(null);

  // Fetch keys from VPS when bridge is ready
  const fetchKeys = useCallback(async () => {
    if (!ready) return;
    setLoading(true);
    try {
      const result = await send<{
        keys: Array<{ fingerprint: string; name: string }>;
      }>("get_ssh_keys");
      setKeys(
        result.keys.map((k) => ({
          id: k.fingerprint,
          fingerprint: k.fingerprint,
          name: k.name,
          addedAt: "",
          addedVia: "vps",
        }))
      );
    } catch (err) {
      console.log("Could not fetch keys, using initial:", err);
    } finally {
      setLoading(false);
    }
  }, [ready, send]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  const handleAddKey = async () => {
    if (!newKeyValue.trim()) {
      setError(t("publicKeyRequired"));
      return;
    }
    if (!ready) {
      setError(t("connectingToServer"));
      return;
    }

    setIsAdding(true);
    setError(null);

    try {
      const result = await send<{ fingerprint: string }>("add_ssh_key", {
        name: newKeyName.trim() || t("defaultKeyName"),
        publicKey: newKeyValue.trim(),
      });

      setKeys((prev) => [
        ...prev,
        {
          id: result.fingerprint,
          fingerprint: result.fingerprint,
          name: newKeyName.trim() || t("defaultKeyName"),
          addedAt: new Date().toISOString(),
          addedVia: "vps",
        },
      ]);

      setNewKeyName("");
      setNewKeyValue("");
      setShowAddForm(false);
      onKeysChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("addFailed"));
    } finally {
      setIsAdding(false);
    }
  };

  const handleRemoveKey = async (fingerprint: string) => {
    setRemovingKey(fingerprint);
    try {
      await send("remove_ssh_key", { fingerprint });
      setKeys((prev) => prev.filter((k) => k.fingerprint !== fingerprint));
      onKeysChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("removeFailed"));
    } finally {
      setRemovingKey(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Key className="h-4 w-4 text-cream/65" />
          <p className="text-sm font-medium text-cream/75">{t("title")}</p>
          <Fingerprint className="h-3 w-3 text-cream/65" />
        </div>
        {(loading || !ready) && <Spinner size="xs" color="muted" />}
      </div>

      {!ready && !bridgeError && (
        <p className="text-xs text-cream/60">
          {t("connectingToServer")}
        </p>
      )}

      {!ready && bridgeError && (
        <p className="text-xs text-terra">
          {t("connectionFailed")}
        </p>
      )}

      {ready && keys.length > 0 && (
        <div className="space-y-2 max-h-40 overflow-y-auto">
          {keys.map((key) => (
            <div
              key={key.fingerprint}
              className="flex items-center justify-between rounded-md bg-cream/5 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-cream/75 truncate">
                  {key.name}
                </div>
                <code className="text-[10px] text-cream/60 truncate block">
                  {key.fingerprint}
                </code>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-terra hover:text-terra hover:bg-terra/10 h-6 px-2 text-xs ml-2"
                onClick={() => handleRemoveKey(key.fingerprint)}
                disabled={removingKey === key.fingerprint}
              >
                {removingKey === key.fingerprint ? (
                  <Spinner size="xs" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
              </Button>
            </div>
          ))}
        </div>
      )}

      {ready && keys.length === 0 && !showAddForm && (
        <p className="text-xs text-cream/60">
          {t("noKeysHintWebLocked")}
        </p>
      )}

      {error && <p className="text-xs text-terra">{error}</p>}

      {ready && (
        <>
          {showAddForm ? (
            <div className="space-y-2 rounded-md bg-cream/5 p-3">
              <Input
                placeholder={t("keyNamePlaceholder")}
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                className="h-8 text-xs bg-card/20 border-border"
              />
              <Textarea
                placeholder={t("keyPlaceholder")}
                value={newKeyValue}
                onChange={(e) => {
                  setNewKeyValue(e.target.value);
                  setError(null);
                }}
                className="min-h-[60px] text-xs font-mono bg-card/20 border-border"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="h-7 text-xs bg-sodium hover:bg-sodium"
                  onClick={handleAddKey}
                  disabled={isAdding || !newKeyValue.trim()}
                >
                  {isAdding && <Spinner size="xs" className="mr-1" />}
                  <Fingerprint className="h-3 w-3 mr-1" />
                  {t("addKey")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setShowAddForm(false);
                    setNewKeyName("");
                    setNewKeyValue("");
                    setError(null);
                  }}
                >
                  {t("cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-full h-7 text-xs border-sodium/30 text-sodium hover:bg-sodium/10"
              onClick={() => setShowAddForm(true)}
            >
              <Plus className="h-3 w-3 mr-1" />
              {t("addSshKey")}
            </Button>
          )}
        </>
      )}

      <p className="text-[10px] text-cream/45">
        <Fingerprint className="h-3 w-3 inline mr-1" />
        {t("footerWebLocked")}
      </p>
    </div>
  );
}
