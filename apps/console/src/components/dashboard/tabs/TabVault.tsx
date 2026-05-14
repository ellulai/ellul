// SPDX-License-Identifier: MIT
"use client";

import { BookOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { VaultNotesBrowser } from "../vault/VaultNotesBrowser";
import { VaultGraphView } from "../vault/VaultGraphView";
import { VaultScopesManager } from "../vault/VaultScopesManager";

interface TabVaultProps {
  activeTab: "notes" | "graph" | "scopes";
  serverDomain: string | null;
  activeProject: string | null;
}

// Top-level vault tab container.
export function TabVault({ activeTab, serverDomain, activeProject }: TabVaultProps) {
  const t = useTranslations("console.vault");

  if (!serverDomain || !activeProject) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <BookOpen className="h-8 w-8 mx-auto text-cream/35" />
          <p className="text-xs text-cream/60">{t("selectProject")}</p>
        </div>
      </div>
    );
  }

  switch (activeTab) {
    case "notes":
      return <VaultNotesBrowser serverDomain={serverDomain} project={activeProject} />;
    case "graph":
      return <VaultGraphView serverDomain={serverDomain} project={activeProject} />;
    case "scopes":
      return <VaultScopesManager serverDomain={serverDomain} project={activeProject} />;
    default:
      return <VaultNotesBrowser serverDomain={serverDomain} project={activeProject} />;
  }
}
