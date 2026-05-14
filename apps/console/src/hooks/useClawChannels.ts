// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { getCodeApiUrl } from "@/lib/domains";
import { useCodeToken } from "@/contexts/CodeTokenContext";

export interface ChannelConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export type ChannelsMap = Record<string, ChannelConfig>;

export function useClawChannels(serverDomain: string, project?: string | null) {
  const t = useTranslations("console.hooks.clawChannels");
  const codeApiUrl = getCodeApiUrl(serverDomain);
  const { fetchWithCodeToken } = useCodeToken();
  const [channels, setChannels] = useState<ChannelsMap>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectParam = project ? `?project=${encodeURIComponent(project)}` : "";

  const fetchChannels = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetchWithCodeToken(`${codeApiUrl}/api/zeroclaw/channels${projectParam}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch channels");
      const data = await res.json();
      setChannels(data.channels || {});
      setError(null);
    } catch (e) {
      setError(t("loadFailed"));
    } finally {
      setIsLoading(false);
    }
  }, [codeApiUrl, fetchWithCodeToken, projectParam, t]);

  const saveChannel = useCallback(
    async (channel: string, config: ChannelConfig) => {
      setIsSaving(true);
      try {
        const res = await fetchWithCodeToken(
          `${codeApiUrl}/api/zeroclaw/channels/${channel}${projectParam}`,
          {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config),
          }
        );
        if (!res.ok) throw new Error("Failed to save channel");
        // Refresh channels after save
        await fetchChannels();
        return true;
      } catch (e) {
        setError(t("saveFailed"));
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [codeApiUrl, fetchWithCodeToken, fetchChannels, projectParam, t]
  );

  return {
    channels,
    isLoading,
    isSaving,
    error,
    fetchChannels,
    saveChannel,
  };
}
