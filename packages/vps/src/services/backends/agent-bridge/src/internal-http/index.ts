// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { IncomingMessage, Server as HttpServer, ServerResponse } from "http";

import type { ApplicationRuntime } from "../composition/ApplicationLayer";
import {
  handleAuthCancel,
  handleAuthClaudeLogout,
  handleAuthClaudeToken,
  handleAuthEvents,
  handleAuthInput,
  handleAuthStart,
} from "./auth-routes";
import { makeCleanupProjectHandler } from "./cleanup-routes";
import {
  handleContextModeGet,
  handleContextModeSet,
} from "./context-mode-routes";
import {
  handleToolPermissionReset,
  handleToolPermissionSet,
} from "./tool-permission-routes";
import { makeResolveProjectsHandler } from "./project-resolver-routes";
import { makeEnsureProjectsHandler } from "./ensure-projects-routes";
import { handleDaemonHealth, handleDaemonRestart } from "./daemon-routes";
import {
  makeDeployAuthorizedHandler,
  makeGitPushAuthorizedHandler,
} from "./deploy-routes";
import {
  handleGateMetrics,
  handleGateStatus,
  handleSecretNames,
  makeGateRequestHandler,
  makeGateResolvedHandler,
} from "./gate-routes";
import { handleHealth } from "./health-routes";
import { handleMetadataChanged, handleReloadIntegrations } from "./metadata-routes";
import { handleFeaturesGet, handleFeaturesToggle, handleGbrainWipe, handleToolProviderSet, handleConnectorSaveKey, handleConnectorRemoveKey } from "./features-routes";
import { makeProviderRefreshHandler } from "./provider-refresh-routes";
import { handleSessionRevoked } from "./revoke-routes";
import {
  handleScaffold,
  makeOpenapiMissingHandler,
  makePreviewErrorHandler,
} from "./selfheal-routes";
import { makeRuntimeRoutes } from "./runtime-routes";
import type { RuntimeServices } from "../composition/runtime-control/RuntimeControlLayer";

export interface AttachInternalHttpDeps {
  readonly httpServer: HttpServer;
  readonly runtime: ApplicationRuntime;
  readonly services?: RuntimeServices;
}

type UrlRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => Promise<void>;
type SimpleRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
type RouteHandler = UrlRouteHandler | SimpleRouteHandler;

interface RouteEntry {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly handler: RouteHandler;
  readonly wantsUrl?: boolean;
}

export function attachInternalHttp({ httpServer, runtime, services }: AttachInternalHttpDeps): () => void {
  const runtimeRoutes: ReadonlyArray<RouteEntry> = services
    ? makeRuntimeRoutes(services).map((r) => ({ method: r.method, path: r.path, handler: r.handler }))
    : [];
  const routes: ReadonlyArray<RouteEntry> = [
    ...runtimeRoutes,
    { method: "GET", path: "/health", handler: handleHealth },
    { method: "GET", path: "/api/internal/daemon-health", handler: handleDaemonHealth },
    { method: "POST", path: "/api/internal/daemon-restart", handler: handleDaemonRestart },
    { method: "POST", path: "/api/internal/metadata-changed", handler: handleMetadataChanged },
    {
      method: "POST",
      path: "/api/internal/reload-integrations",
      handler: handleReloadIntegrations,
    },
    { method: "POST", path: "/api/cleanup-project", handler: makeCleanupProjectHandler(runtime) },
    { method: "POST", path: "/api/internal/session-revoked", handler: handleSessionRevoked },
    { method: "POST", path: "/api/internal/preview-error", handler: makePreviewErrorHandler(runtime) },
    { method: "POST", path: "/api/internal/scaffold", handler: handleScaffold },
    {
      method: "POST",
      path: "/api/internal/openapi-missing",
      handler: makeOpenapiMissingHandler(runtime),
    },
    {
      method: "GET",
      path: "/api/internal/gate/cross-project-scope-metrics",
      handler: handleGateMetrics,
    },
    {
      method: "POST",
      path: "/api/internal/gate-request",
      handler: makeGateRequestHandler(runtime),
    },
    {
      method: "POST",
      path: "/api/internal/gate-resolved",
      handler: makeGateResolvedHandler(runtime),
    },
    {
      method: "GET",
      path: "/api/internal/gate-status",
      handler: handleGateStatus,
      wantsUrl: true,
    },
    {
      method: "GET",
      path: "/api/internal/secret-names",
      handler: handleSecretNames,
      wantsUrl: true,
    },
    {
      method: "POST",
      path: "/api/internal/deploy-authorized",
      handler: makeDeployAuthorizedHandler(runtime),
    },
    {
      method: "POST",
      path: "/api/internal/git-push-authorized",
      handler: makeGitPushAuthorizedHandler(runtime),
    },
    {
      method: "GET",
      path: "/api/internal/context-mode",
      handler: handleContextModeGet,
      wantsUrl: true,
    },
    {
      method: "POST",
      path: "/api/internal/context-mode",
      handler: handleContextModeSet,
    },
    {
      method: "POST",
      path: "/api/internal/tool-permissions",
      handler: handleToolPermissionSet,
    },
    {
      method: "POST",
      path: "/api/internal/tool-permissions/reset",
      handler: handleToolPermissionReset,
    },
    {
      method: "POST",
      path: "/api/internal/resolve-projects",
      handler: makeResolveProjectsHandler(runtime),
    },
    {
      method: "POST",
      path: "/api/internal/ensure-projects",
      handler: makeEnsureProjectsHandler(runtime),
    },
    { method: "POST", path: "/api/internal/auth/start", handler: handleAuthStart },
    {
      method: "GET",
      path: "/api/internal/auth/events",
      handler: handleAuthEvents,
      wantsUrl: true,
    },
    {
      method: "POST",
      path: "/api/internal/auth/input",
      handler: handleAuthInput,
      wantsUrl: true,
    },
    {
      method: "POST",
      path: "/api/internal/auth/cancel",
      handler: handleAuthCancel,
      wantsUrl: true,
    },
    {
      method: "POST",
      path: "/api/internal/auth/claude-token",
      handler: handleAuthClaudeToken,
    },
    {
      // Greenfield logout — proxies to shield's /api/internal/claude-oat/revoke.
      // Bridge holds no credential state; the only side-effect of hitting
      // this endpoint is shield clearing the encrypted store atomically.
      method: "POST",
      path: "/api/internal/auth/claude-logout",
      handler: handleAuthClaudeLogout,
    },
    { method: "GET", path: "/api/internal/features", handler: handleFeaturesGet },
    { method: "POST", path: "/api/internal/features/toggle", handler: handleFeaturesToggle },
    { method: "POST", path: "/api/internal/features/gbrain-wipe", handler: handleGbrainWipe },
    { method: "POST", path: "/api/internal/features/tool-provider", handler: handleToolProviderSet },
    { method: "POST", path: "/api/internal/features/connector-key", handler: handleConnectorSaveKey },
    { method: "POST", path: "/api/internal/features/connector-key-remove", handler: handleConnectorRemoveKey },
    { method: "POST", path: "/api/internal/providers/refresh", handler: makeProviderRefreshHandler(runtime) },
  ];

  const routeTable = new Map<string, RouteEntry>();
  for (const entry of routes) {
    routeTable.set(`${entry.method} ${entry.path}`, entry);
  }

  const listener = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url || "/", "http://localhost");
    const key = `${req.method ?? "GET"} ${url.pathname}`;
    const entry = routeTable.get(key);
    if (!entry) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      if (entry.wantsUrl) {
        await (entry.handler as UrlRouteHandler)(req, res, url);
      } else {
        await (entry.handler as SimpleRouteHandler)(req, res);
      }
    } catch (err) {
      console.error(`[Bridge] Internal HTTP handler failure (${key}):`, (err as Error).message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "internal error" }));
      }
    }
  };

  httpServer.on("request", listener);
  return () => httpServer.off("request", listener);
}
