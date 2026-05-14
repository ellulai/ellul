// SPDX-License-Identifier: MIT
"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Check, Eye, EyeOff, ExternalLink, ChevronDown } from "lucide-react";
import { useLlmKeys } from "@/hooks/useLlmKeys";

function useProviders() {
  const t = useTranslations("console.modelProviders");
  return [
    { id: "anthropic", name: t("providerLabel.anthropic"), url: "https://console.anthropic.com/settings/keys" },
    { id: "openai", name: t("providerLabel.openai"), url: "https://platform.openai.com/api-keys" },
    { id: "openrouter", name: t("providerLabel.openrouter"), url: "https://openrouter.ai/settings/keys" },
    { id: "google", name: t("providerLabel.googleAi"), url: "https://aistudio.google.com/apikey" },
  ] as const;
}

function useProviderDisplay(): Record<string, string> {
  const t = useTranslations("console.modelProviders");
  return {
    anthropic: t("providerLabel.anthropic"),
    openai: t("providerLabel.openai"),
    openrouter: t("providerLabel.openrouter"),
    google: t("providerLabel.google"),
  };
}

interface ModelProvidersProps {
  serverId: string;
  serverDomain: string;
  hideHeader?: boolean;
}

export function ModelProviders({ serverId, serverDomain, hideHeader }: ModelProvidersProps) {
  const t = useTranslations("console.modelProviders");
  const PROVIDERS = useProviders();
  const PROVIDER_DISPLAY = useProviderDisplay();
  const { hasKey, provider, modelId, isLoading, saveKey, removeKey, isSaving, saveError } = useLlmKeys(serverId, serverDomain);
  const [keyValue, setKeyValue] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<string>("anthropic");
  const [modelIdValue, setModelIdValue] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [showProviderDropdown, setShowProviderDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showProviderDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowProviderDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showProviderDropdown]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner delay={300} />
      </div>
    );
  }

  const handleSave = async () => {
    if (!keyValue.trim()) return;
    await saveKey(
      keyValue.trim(),
      selectedProvider,
      selectedProvider === "openrouter" ? modelIdValue.trim() || undefined : undefined,
    );
    setKeyValue("");
    setModelIdValue("");
    setIsEditing(false);
  };

  const handleRemove = async () => {
    await removeKey();
    setIsEditing(false);
    setKeyValue("");
    setModelIdValue("");
  };

  const providerLabel = provider ? PROVIDER_DISPLAY[provider] || provider : null;

  return (
    <div>
      {!hideHeader && (
        <div className="mb-6">
          <h2 className="text-base font-medium text-cream mb-1">{t("title")}</h2>
          <p className="text-sm text-cream/60">
            {t("subtitle")}
          </p>
        </div>
      )}

      <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-cream">{t("apiKey")}</span>
            {hasKey && providerLabel ? (
              <span className="flex items-center gap-1 rounded-full border border-sodium/30 bg-sodium/10 px-2 py-0.5 text-[10px] text-sodium">
                <Check className="h-2.5 w-2.5" />
                {providerLabel}
                {provider === "openrouter" && modelId && (
                  <span className="text-sodium/70 ml-0.5">
                    ({modelId.replace('openrouter/', '')})
                  </span>
                )}
              </span>
            ) : hasKey ? (
              <span className="flex items-center gap-1 rounded-full border border-sodium/30 bg-sodium/10 px-2 py-0.5 text-[10px] text-sodium">
                <Check className="h-2.5 w-2.5" />
                {t("configured")}
              </span>
            ) : (
              <span className="rounded-full border border-cream/[0.08] bg-cream/[0.03] px-2 py-0.5 text-[10px] text-cream/45">
                {t("notSet")}
              </span>
            )}
          </div>

          {hasKey && !isEditing && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setIsEditing(true)}
                className="text-xs h-7 border-cream/[0.08]"
              >
                {t("update")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleRemove}
                disabled={isSaving}
                className="text-xs h-7 border-terra/20 text-terra hover:bg-terra/10"
              >
                {t("remove")}
              </Button>
            </div>
          )}
        </div>

        <p className="text-xs text-cream/45 mb-3">
          {t("byok")}
        </p>

        {(!hasKey || isEditing) && (
          <div className="space-y-3">
            {/* Provider selector */}
            <div className="relative" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setShowProviderDropdown(!showProviderDropdown)}
                className="w-full flex items-center justify-between rounded-md border border-cream/[0.08] bg-cream/[0.03] px-3 py-2 text-sm text-cream hover:border-cream/[0.15] focus:border-sodium/50 focus:outline-none transition-colors"
              >
                <span>{PROVIDERS.find((p) => p.id === selectedProvider)?.name}</span>
                <ChevronDown
                  className={`h-3.5 w-3.5 text-cream/60 transition-transform ${showProviderDropdown ? "rotate-180" : ""}`}
                />
              </button>
              {showProviderDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl z-50 py-1 animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150">
                  {PROVIDERS.map((p) => {
                    const isActive = p.id === selectedProvider;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setSelectedProvider(p.id);
                          setShowProviderDropdown(false);
                        }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary transition-colors ${
                          isActive ? "bg-sodium/10 text-ink" : "text-cream/75"
                        }`}
                      >
                        {isActive && (
                          <span className="w-1.5 h-1.5 rounded-full bg-sodium shrink-0" />
                        )}
                        <span className={isActive ? "" : "ml-[14px]"}>{p.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Key input */}
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={keyValue}
                onChange={(e) => setKeyValue(e.target.value)}
                placeholder={t("keyPlaceholder")}
                className="w-full rounded-md border border-cream/[0.08] bg-cream/[0.03] px-3 py-2 pr-9 text-sm text-cream placeholder:text-cream/45 focus:border-sodium/50 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-cream/45 hover:text-cream transition-colors"
              >
                {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>

            {/* Model ID input — OpenRouter only */}
            {selectedProvider === "openrouter" && (
              <div>
                <input
                  type="text"
                  value={modelIdValue}
                  onChange={(e) => setModelIdValue(e.target.value)}
                  placeholder={t("modelIdPlaceholder")}
                  className="w-full rounded-md border border-cream/[0.08] bg-cream/[0.03] px-3 py-2 text-sm text-cream placeholder:text-cream/45 focus:border-sodium/50 focus:outline-none"
                />
                <p className="mt-1 text-[10px] text-cream/45">
                  {t("browseModelsPrefix")}{" "}
                  <a href="https://openrouter.ai/models" target="_blank" rel="noopener noreferrer" className="text-cream/60 hover:text-cream transition-colors underline">
                    openrouter.ai/models
                  </a>
                  {t("browseModelsSuffix")}
                </p>
              </div>
            )}

            {/* Save + cancel */}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={isSaving || !keyValue.trim()}
                className="bg-sodium hover:bg-sodium h-9"
              >
                {isSaving ? <Spinner size="sm" delay={300} /> : t("save")}
              </Button>
              {isEditing && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setIsEditing(false); setKeyValue(""); setModelIdValue(""); }}
                  className="h-9 border-cream/[0.08]"
                >
                  {t("cancel")}
                </Button>
              )}
            </div>

            {/* Provider links */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] text-cream/45">{t("getKey")}</span>
              {PROVIDERS.map((p) => (
                <a
                  key={p.id}
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[10px] text-cream/60 hover:text-cream transition-colors"
                >
                  {p.name}
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              ))}
            </div>
          </div>
        )}

        {!hasKey && !isEditing && (
          <div className="flex flex-wrap items-center gap-2">
            {PROVIDERS.map((p) => (
              <a
                key={p.id}
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-cream/[0.08] px-3 py-2 text-xs text-cream/75 hover:text-cream hover:border-cream/[0.15] transition-colors"
              >
                {p.name}
                <ExternalLink className="h-3 w-3" />
              </a>
            ))}
          </div>
        )}
      </div>

      {saveError && (
        <p className="mt-3 text-xs text-terra">{saveError}</p>
      )}
    </div>
  );
}
