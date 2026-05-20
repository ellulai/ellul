// SPDX-License-Identifier: MIT
"use client";

import { useTranslations } from "next-intl";
import { TabVault } from "../tabs/TabVault";
import { TabSecrets } from "../tabs/TabSecrets";
import { TabPermissions, TabMonitor } from "../tabs/TabSecurity";
import {
  ObservabilityDevelopment,
  ObservabilityHealth,
  ObservabilityClaw,
} from "../tabs/TabObservability";
import { DatabaseBrowser } from "../database";
import { IntAiAgents, ConnectionGroupTab } from "../integrations";
import type { IntegrationGroup } from "@/hooks/useIntegrationGroups";
import { ContextSettings } from "../ContextSettings";
import type { ContextContentProps } from "./layout-types";
import { isContextVisible } from "@/lib/feature-flags";
import { isLocalServer } from "@/lib/domains";

export function ContextContent({
  server,
  app,
  sandboxes,
  serverDomain,
  selectedApp,
  selectedAppName,
  appContext,
  currentTabId,
  vaultTab,
  databaseTab,
  observabilityTab,
  settingsTab,
  onUpgrade,
  onBackToOverview,
  integrationGroups,
  deleteSandbox,
  isDeletingSandbox,
}: ContextContentProps) {
  const t = useTranslations("console.contextContent");
  const flatApps = sandboxes.flatMap((s) => s.apps);
  const appsSlim = flatApps.map((a) => ({
    name: a.name,
    directory: a.directory,
    type: a.type,
  }));
  const allProjects = flatApps.map((a) => a.directory);

  // Delete from the danger zone takes an app/sandbox directory. Extract the
  const handleDeleteFromDangerZone = deleteSandbox
    ? async (dir: string) => {
        const sandboxId = dir.split("/")[0] ?? dir;
        return deleteSandbox(sandboxId);
      }
    : undefined;

  return (
    <>
      {/* Vault Context - Scoped Knowledge Vault (release-gated) */}
      {isContextVisible("vault") && (
        <div
          className={
            appContext === "vault" ? "flex-1 flex flex-col min-h-0" : "hidden"
          }
        >
          <div className="flex-1 flex flex-col min-h-0 panel-ascente overflow-hidden">
            <TabVault
              activeTab={vaultTab}
              serverDomain={serverDomain}
              activeProject={selectedApp}
            />
          </div>
        </div>
      )}

      {/* Integrations Context - dynamic groups */}
      {appContext === "integrations" && (
        <div className="flex-1 flex flex-col min-h-0">
          {/* ZeroClaw - system defined, always present */}
          <div
            className={
              currentTabId === "zeroclaw"
                ? "flex-1 flex flex-col min-h-0 overflow-y-auto panel-ascente"
                : "hidden"
            }
          >
            <IntAiAgents
              serverId={server.id}
              serverDomain={serverDomain}
              apps={appsSlim}
              selectedApp={selectedApp}
            />
          </div>
          {/* User-created groups - rendered dynamically */}
          {integrationGroups.map((group) => (
            <div
              key={group.id}
              className={
                currentTabId === group.id
                  ? "flex-1 flex flex-col min-h-0 overflow-y-auto panel-ascente"
                  : "hidden"
              }
            >
              <ConnectionGroupTab
                group={group}
                serverId={server.id}
                serverDomain={serverDomain}
                selectedApp={selectedApp}
              />
            </div>
          ))}
        </div>
      )}

      {/* Database Context - kept mounted to preserve query cache.
          DBs are sandbox-scoped (one pool per sandbox, shared across all
          apps via dotenv inheritance on the server). If no app is
          selected, fall back to the current sandbox slug so the user
          can still create/browse databases without scaffolding first. */}
      <div
        className={
          appContext === "database" ? "flex-1 flex flex-col min-h-0" : "hidden"
        }
      >
        {(() => {
          const dbScope =
            app?.sandboxId ??
            (selectedApp ? selectedApp.split("/")[0] : undefined) ??
            sandboxes[0]?.id;
          if (!dbScope) {
            return (
              <div className="flex-1 flex items-center justify-center p-8">
                <div className="max-w-sm text-center space-y-3">
                  <div className="mx-auto w-10 h-10 rounded-lg bg-cream/[0.04] border border-cream/[0.06] flex items-center justify-center">
                    <svg className="w-5 h-5 text-cream/60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <ellipse cx="12" cy="6" rx="8" ry="3" />
                      <path d="M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6" />
                      <path d="M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-cream/85">{t("noSandbox")}</p>
                  <p className="text-xs text-cream/45 leading-relaxed">
                    {t("createSandboxHint")}
                  </p>
                </div>
              </div>
            );
          }
          return (
            <DatabaseBrowser
              serverDomain={serverDomain}
              sandboxId={dbScope}
              tier={server.securityTier ?? "standard"}
              activeTab={databaseTab}
            />
          );
        })()}
      </div>

      {/* Observability Context - kept mounted to preserve query cache */}
      <div
        className={
          appContext === "observability"
            ? "flex-1 flex flex-col min-h-0"
            : "hidden"
        }
      >
        <div
          className={
            observabilityTab === "development"
              ? "flex-1 flex flex-col min-h-0 overflow-y-auto panel-ascente"
              : "hidden"
          }
        >
          <ObservabilityDevelopment serverDomain={serverDomain} />
        </div>
        <div
          className={
            observabilityTab === "gates"
              ? "flex-1 flex flex-col min-h-0 overflow-y-auto panel-ascente"
              : "hidden"
          }
        >
          <TabMonitor
            serverId={server.id}
            securityTier={server.securityTier ?? "standard"}
            serverDomain={serverDomain}
          />
        </div>
        <div
          className={
            observabilityTab === "health"
              ? "flex-1 flex flex-col min-h-0 overflow-y-auto panel-ascente"
              : "hidden"
          }
        >
          <ObservabilityHealth
            serverDomain={serverDomain}
          />
        </div>
        <div
          className={
            observabilityTab === "claw"
              ? "flex-1 flex flex-col min-h-0 overflow-y-auto panel-ascente"
              : "hidden"
          }
        >
          <ObservabilityClaw
            serverDomain={serverDomain}
            securityTier={server.securityTier ?? "standard"}
          />
        </div>
      </div>

      {/* Settings Context - kept mounted to preserve query cache */}
      <div
        className={
          appContext === "settings" ? "flex-1 flex flex-col min-h-0" : "hidden"
        }
      >
        <div
          className={
            settingsTab === "secrets"
              ? "flex-1 flex flex-col min-h-0 overflow-y-auto panel-ascente"
              : "hidden"
          }
        >
          <TabSecrets
            serverId={server.id}
            securityTier={server.securityTier ?? "standard"}
            serverDomain={serverDomain}
            onUpgrade={onUpgrade}
            app={app ?? null}
            isLocal={isLocalServer(server)}
          />
        </div>
        <div
          className={
            settingsTab === "security"
              ? "flex-1 flex flex-col min-h-0 overflow-y-auto panel-ascente"
              : "hidden"
          }
        >
          <TabPermissions
            serverId={server.id}
            securityTier={server.securityTier ?? "standard"}
            serverDomain={serverDomain}
            app={app ?? null}
            allProjects={allProjects}
            dangerZone={
              selectedAppName && selectedApp && handleDeleteFromDangerZone
                ? {
                    sandboxId: selectedAppName,
                    appDirectory: selectedApp,
                    onDelete: handleDeleteFromDangerZone,
                    isDeleting: isDeletingSandbox ?? false,
                    onDeleteSuccess: onBackToOverview,
                  }
                : undefined
            }
          />
        </div>
        <div
          className={
            settingsTab === "context"
              ? "flex-1 flex flex-col min-h-0 overflow-y-auto panel-ascente"
              : "hidden"
          }
        >
          <ContextSettings
            serverDomain={serverDomain}
            appOnly={true}
            app={app}
          />
        </div>
      </div>
    </>
  );
}
