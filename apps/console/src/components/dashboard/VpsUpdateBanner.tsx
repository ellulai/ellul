// SPDX-License-Identifier: MIT
"use client";

import { useContext } from "react";
import { useTranslations } from "next-intl";
import { ArrowUpCircle, Sparkles } from "lucide-react";
import { VpsCapabilitiesContext } from "@/providers/VpsCapabilitiesProvider";

// All features the latest platform knows about.
const LATEST_FEATURES = [
  "passkey",
  "pop",
  "ssh-keys",
  "tier-switch",
  "terminal-tokens",
  "code-browser",
  "agent-bridge",
] as const;

const FEATURE_KEYS: Record<string, string> = {
  "passkey": "passkey",
  "pop": "pop",
  "ssh-keys": "sshKeys",
  "tier-switch": "tierSwitch",
  "terminal-tokens": "terminalTokens",
  "code-browser": "codeBrowser",
  "agent-bridge": "agentBridge",
};

// Shows a banner when the connected VPS is missing features available in the latest version.
export function VpsUpdateBanner() {
  const t = useTranslations("console.vpsUpdateBanner");
  const caps = useContext(VpsCapabilitiesContext);

  // Don't render until capabilities have loaded, or if VPS is too old / in dark mode
  if (!caps?.features) return null;

  const missing = LATEST_FEATURES.filter((f) => !caps.features.includes(f));

  // Nothing missing — VPS is up to date
  if (missing.length === 0) return null;

  return (
    <div className="border-b border-blue-500/10 bg-blue-500/[0.03]">
      <div className="max-w-6xl mx-auto px-3 sm:px-4 md:px-6 py-3 sm:py-4">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0 mt-0.5">
            <ArrowUpCircle className="h-4 w-4 text-blue-400" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium text-blue-300">
              {t("title")}
            </h3>
            <p className="text-xs text-cream/60 mt-0.5">
              {missing.length === 1 ? t("rebuildSingular") : t("rebuildPlural")}
            </p>
            <ul className="mt-2 space-y-1">
              {missing.map((feature) => {
                const key = FEATURE_KEYS[feature];
                const label = key ? t(`features.${key}` as `features.passkey`) : feature;
                return (
                  <li key={feature} className="flex items-center gap-2 text-xs text-cream/60">
                    <Sparkles className="h-3 w-3 text-blue-400 shrink-0" />
                    {label}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
