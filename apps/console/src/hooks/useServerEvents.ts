// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { API_URL } from "@/lib/api";
import { useNativeNotifications } from "@/hooks/useNativeNotifications";
import { deriveTierFields, type ServerSecurityTier } from "@/lib/environment-lock";

// old stream, so there are never stale connections or 429s.

// Stable per-tab identifier — survives page navigations within a tab,
function getTabId(): string {
  const key = "sse-tab-id";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

interface UseServerEventsOptions {
  enabled?: boolean;
  // Server ID to scope SSE events to. When provided, only events for this server are received.
  serverId?: string | null;
}

export function useServerEvents({ enabled = true, serverId }: UseServerEventsOptions = {}) {
  const queryClient = useQueryClient();
  const t = useTranslations("console.serverStatus.stepLabels");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const abortRef = useRef<AbortController | null>(null);
  const visibilityRef = useRef(true);
  const { sendNotification } = useNativeNotifications();

  const handleEvent = useCallback(
    (eventType: string, data: Record<string, unknown>) => {
      // Fire native notification for server events
      sendNotification(eventType, data);

      switch (eventType) {
        case "initial_state": {
          // Full state push — replace entire serverStatus cache
          queryClient.setQueryData(["server-status"], data);

          // Also update granular caches if data contains those fields
          const serverId = (data as { server?: { id?: string } })?.server?.id;
          if (serverId) {
            if (data.deploymentModel !== undefined) {
              queryClient.setQueryData(["server-deployment-model", serverId], {
                deploymentModel: data.deploymentModel,
              });
            }
            if (data.securityTier !== undefined) {
              queryClient.setQueryData(["security-tier", serverId], data.security);
            }
            if (data.server) {
              const server = data.server as Record<string, unknown>;
              queryClient.setQueryData(["server-status", serverId], {
                terminalEnabled: server.terminalEnabled,
                sshEnabled: server.sshEnabled,
              });
              queryClient.setQueryData(["access-status", serverId], {
                terminalEnabled: server.terminalEnabled,
                sshEnabled: server.sshEnabled,
                isSovereign: (data as { securityTier?: string }).securityTier !== "standard",
              });
            }
          }
          break;
        }

        case "state_changed": {
          // Merge into serverStatus cache
          queryClient.setQueryData(
            ["server-status"],
            (old: Record<string, unknown> | undefined) => {
              if (!old) return old;
              const merged = { ...old, ...data };

              // Build / merge the nested operation object.
              const stepLabels: Record<string, string> = {
                starting: t("starting_dots"),
                writing_files: t("writing_files"),
                packages: t("packages_dots"),
                nodejs: t("nodejs_dots"),
                devtools: t("devtools"),
                opencode: t("opencode_dots"),
                configuring: t("configuring_dots"),
                services: t("services"),
                ready: t("ready"),
              };

              if (data.operation && typeof data.operation === "object") {
                // Nested operation object from update/heartbeat events
                const op = data.operation as { type: string | null; step: string | null; startedAt?: string | null };
                const step = op.step || null;
                merged.operation = {
                  type: op.type,
                  step,
                  startedAt: op.startedAt ?? null,
                  label: step ? (stepLabels[step] || t("settingUp")) : null,
                  isReady: step === "ready",
                };
              } else if (data.operationStep) {
                // Flat operationStep from provisioning progress events
                const step = data.operationStep as string;
                const oldOp = (old.operation || {}) as Record<string, unknown>;
                merged.operation = {
                  type: oldOp.type ?? null,
                  step,
                  startedAt: oldOp.startedAt ?? null,
                  label: stepLabels[step] || t("settingUp"),
                  isReady: step === "ready",
                };
              }

              // Merge server fields (ipAddress, domain, volumeSecurityMode)
              if (data.ipAddress || data.domain || data.volumeSecurityMode !== undefined) {
                const server = (old.server || {}) as Record<string, unknown>;
                merged.server = { ...server };
                if (data.ipAddress) (merged.server as Record<string, unknown>).ipAddress = data.ipAddress;
                if (data.domain) (merged.server as Record<string, unknown>).domain = data.domain;
                if (data.volumeSecurityMode !== undefined) (merged.server as Record<string, unknown>).volumeSecurityMode = data.volumeSecurityMode;
              }

              // Merge deployments if present (from full state push or poll)
              if (data.deployments) {
                merged.deployments = data.deployments;
              }

              return merged;
            }
          );
          break;
        }

        case "deployment_changed": {
          const serverId = data.serverId as string;
          if (serverId) {
            queryClient.setQueryData(["server-deployment-model", serverId], {
              deploymentModel: data.deploymentModel,
            });
          }
          // Also update main status cache
          queryClient.setQueryData(
            ["server-status"],
            (old: Record<string, unknown> | undefined) => {
              if (!old) return old;
              return {
                ...old,
                deploymentModel: data.deploymentModel,
              };
            }
          );
          break;
        }

        case "security_changed": {
          const serverId = data.serverId as string;
          const newTier = data.securityTier as ServerSecurityTier | undefined;
          if (serverId && newTier) {
            // Merge authoritative tier-derived fields into the cache. We
            // do NOT invalidate: a refetch can race the DB write on the
            // VPS->API path and return a stale tier, stomping the push.
            const derived = deriveTierFields(newTier);
            queryClient.setQueryData(
              ["security-tier", serverId],
              (old: Record<string, unknown> | undefined) => ({
                ...(old ?? {}),
                tier: newTier,
                ...derived,
                // Tier transitions away from standard clear SSH keys server-side.
                ...(newTier !== "web_locked" || data.keysCleared ? { sshKeys: [] } : {}),
              })
            );
            queryClient.setQueryData(
              ["server-status"],
              (old: Record<string, unknown> | undefined) => {
                if (!old) return old;
                const server = (old.server || {}) as Record<string, unknown>;
                return {
                  ...old,
                  server: { ...server, securityTier: newTier },
                };
              }
            );
          }
          break;
        }

        case "settings_changed": {
          const serverId = data.serverId as string;
          if (serverId) {
            queryClient.setQueryData(["server-status", serverId], (old: Record<string, unknown> | undefined) => {
              if (!old) return old;
              return { ...old, ...data };
            });
            queryClient.setQueryData(["access-status", serverId], (old: Record<string, unknown> | undefined) => {
              if (!old) return old;
              return { ...old, ...data };
            });
            // Merge terminal/ssh state into the security-tier cache (no invalidate — avoids refetch race).
            queryClient.setQueryData(
              ["security-tier", serverId],
              (old: Record<string, unknown> | undefined) => {
                if (!old) return old;
                const terminalEnabled = data.terminalEnabled as boolean | undefined;
                const sshEnabled = data.sshEnabled as boolean | undefined;
                return {
                  ...old,
                  ...(terminalEnabled !== undefined && {
                    webTerminal: terminalEnabled ? (old.tier === "standard" ? "enabled" : "passkey_required") : "disabled",
                  }),
                  ...(sshEnabled !== undefined && {
                    sshAccess: sshEnabled ? (old.tier === "standard" ? "enabled" : "dynamic") : "disabled",
                  }),
                };
              }
            );
            // Also update main status cache server object
            queryClient.setQueryData(
              ["server-status"],
              (old: Record<string, unknown> | undefined) => {
                if (!old) return old;
                const server = (old.server || {}) as Record<string, unknown>;
                return {
                  ...old,
                  server: { ...server, ...data },
                };
              }
            );
          }
          break;
        }

        case "plan_changed": {
          // Tier changes affect the main serverStatus cache
          queryClient.setQueryData(
            ["server-status"],
            (old: Record<string, unknown> | undefined) => {
              if (!old) return old;
              const server = (old.server || {}) as Record<string, unknown>;
              return {
                ...old,
                server: { ...server, ...data },
              };
            }
          );
          // Show error toast if tier change failed
          if (data.error && typeof data.error === "string") {
            // Dispatch custom event for the dashboard to pick up as a toast/banner
            window.dispatchEvent(
              new CustomEvent("ellul:tier-change-error", {
                detail: { message: data.error, serverId: data.serverId },
              })
            );
          }
          break;
        }

        case "server_deleted": {
          // Invalidate serverStatus to refetch the updated servers list
          queryClient.invalidateQueries({ queryKey: ["server-status"] });
          queryClient.removeQueries({ queryKey: ["server-status"] });
          queryClient.removeQueries({ queryKey: ["server-deployment-model"] });
          queryClient.removeQueries({ queryKey: ["security-tier"] });
          queryClient.removeQueries({ queryKey: ["access-status"] });
          break;
        }

        case "auth_expired": {
          window.location.href = "/";
          break;
        }
      }
    },
    [queryClient]
  );

  useEffect(() => {
    if (!enabled) {
      setConnectionStatus("disconnected");
      return;
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let retryCount = 0;

    const connect = () => {
      setConnectionStatus(retryCount === 0 ? "connecting" : "reconnecting");

      const sseUrl = serverId
        ? `${API_URL}/api/servers/events?tabId=${getTabId()}&serverId=${serverId}`
        : `${API_URL}/api/servers/events?tabId=${getTabId()}`;
      fetchEventSource(sseUrl, {
        signal: ctrl.signal,
        credentials: "include",
        headers: {
          Accept: "text/event-stream",
        },

        onopen: async (response) => {
          if (response.ok) {
            retryCount = 0;
            setConnectionStatus("connected");
          } else if (response.status === 401 || response.status === 403) {
            setConnectionStatus("disconnected");
            throw new Error("Fatal: Unauthorized");
          } else if (response.status === 404) {
            // Endpoint doesn't exist (API not deployed) — stop retrying
            setConnectionStatus("disconnected");
            throw new Error("Fatal: SSE endpoint not found");
          } else {
            // Transient errors (500, 502, 503) — onerror handles backoff
            throw new Error(`SSE connection failed: ${response.status}`);
          }
        },

        onmessage: (ev) => {
          if (!ev.event || ev.event === "keepalive") return;
          try {
            const data = JSON.parse(ev.data);
            handleEvent(ev.event, data);
          } catch {
            // Ignore malformed events
          }
        },

        onerror: (err) => {
          if (ctrl.signal.aborted) return;

          // Fatal errors — stop retrying entirely
          if (err instanceof Error && err.message.startsWith("Fatal:")) {
            setConnectionStatus("disconnected");
            throw err;
          }

          // CORS or network errors that persist — stop after too many attempts
          retryCount++;
          if (retryCount > 5) {
            setConnectionStatus("disconnected");
            throw new Error("Fatal: too many retries");
          }

          setConnectionStatus("reconnecting");

          // Exponential backoff: 1s → 2s → 4s → ... → 30s cap + jitter
          const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 30000);
          const jitter = Math.random() * 1000;
          return delay + jitter;
        },

        onclose: () => {
          if (!ctrl.signal.aborted) {
            setConnectionStatus("reconnecting");
          }
        },
      }).catch(() => {
        // fetchEventSource throws when aborted or on fatal errors
        if (!ctrl.signal.aborted) {
          setConnectionStatus("disconnected");
        }
      });
    };

    connect();

    // Visibility-aware: disconnect on tab hidden, reconnect on visible
    const handleVisibility = () => {
      if (document.hidden) {
        visibilityRef.current = false;
        // Don't disconnect immediately — let keepalive handle it
      } else if (!visibilityRef.current) {
        visibilityRef.current = true;
        // Tab became visible again — invalidate to catch up
        if (abortRef.current && !abortRef.current.signal.aborted) {
          queryClient.invalidateQueries({ queryKey: ["server-status"] });
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      ctrl.abort();
      abortRef.current = null;
      setConnectionStatus("disconnected");
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [enabled, handleEvent, queryClient, serverId]);

  return {
    connectionStatus,
    isConnected: connectionStatus === "connected",
    isReconnecting: connectionStatus === "reconnecting",
  };
}
