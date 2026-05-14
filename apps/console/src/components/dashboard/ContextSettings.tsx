// SPDX-License-Identifier: MIT
"use client";

import { ServerContext } from "@/components/server/ServerContext";
import type { ApiApp } from "@/contexts/AppsListContext";

type AppInfo = ApiApp;

interface ContextSettingsProps {
  serverDomain: string;
  // Only show app-specific context (hide global)
  appOnly?: boolean;
  // Only show global context (hide app-specific)
  globalOnly?: boolean;
  // App info from backend (props-based data flow)
  app?: AppInfo | null;
}

// ContextSettings - App Context/Knowledge Settings Tab
export function ContextSettings({ serverDomain, appOnly, globalOnly, app }: ContextSettingsProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ServerContext
        serverDomain={serverDomain}
        appOnly={appOnly}
        globalOnly={globalOnly}
        app={app}
      />
    </div>
  );
}
