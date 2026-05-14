// SPDX-License-Identifier: MIT
"use client";

import { SecretsManager } from "../SecretsManager";
import { EncryptionFingerprintCard } from "./TabSecurity";
import { tryParseSandboxId } from "@ellul.ai/types";
import type { ApiApp } from "@/contexts/AppsListContext";

type SecurityTier = "standard" | "web_locked" | "private_locked";

type AppInfo = ApiApp;

interface TabSecretsProps {
  serverId: string;
  securityTier: SecurityTier;
  serverDomain: string;
  onUpgrade?: () => void;
  app?: AppInfo | null;
}

export function TabSecrets({ serverId, securityTier, serverDomain, app }: TabSecretsProps) {
  // Secrets are sandbox-scoped. Fold the selected app's directory
  const sandboxId = app ? tryParseSandboxId((app.directory.split("/")[0] ?? "")) : undefined;

  return (
    <div className="p-4 space-y-4 overflow-y-auto flex-1">
      {sandboxId && (
        <SecretsManager
          serverId={serverId}
          tier={securityTier}
          serverDomain={serverDomain}
          sandboxId={sandboxId}
        />
      )}
      <EncryptionFingerprintCard serverId={serverId} />
    </div>
  );
}
