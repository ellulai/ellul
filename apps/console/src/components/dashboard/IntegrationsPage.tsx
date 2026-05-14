// SPDX-License-Identifier: MIT
"use client";

// IntegrationsPage — legacy monolithic integrations view.

export { IntAiAgents, ConnectionGroupTab, CreateGroupModal, ToolReview } from "./integrations";
export type { DiscoveredTool } from "./integrations";

import { IntAiAgents } from "./integrations/IntAiAgents";

interface IntegrationsPageProps {
  serverId: string;
  serverDomain: string;
  apps: Array<{ name: string; directory: string; type: string }>;
  selectedApp?: string | null;
}

export function IntegrationsPage({
  serverId,
  serverDomain,
  apps,
  selectedApp,
}: IntegrationsPageProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      <IntAiAgents
        serverId={serverId}
        serverDomain={serverDomain}
        apps={apps}
        selectedApp={selectedApp}
      />
    </div>
  );
}
