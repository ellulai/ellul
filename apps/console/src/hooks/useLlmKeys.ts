// SPDX-License-Identifier: MIT
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { getCodeApiUrl } from "@/lib/domains";
import { useCodeToken } from "@/contexts/CodeTokenContext";

interface LlmKeyStatus {
  hasKey: boolean;
  provider: string | null;
  modelId: string | null;
}

export function useLlmKeys(serverId: string, serverDomain: string) {
  const t = useTranslations("console.hooks.llmKeys");
  const codeApiUrl = getCodeApiUrl(serverDomain);
  const { fetchWithCodeToken } = useCodeToken();
  const queryClient = useQueryClient();
  const queryKey = ["llm-keys", serverId];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async (): Promise<LlmKeyStatus> => {
      const res = await fetchWithCodeToken(`${codeApiUrl}/api/zeroclaw/llm-key`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(t("loadFailed"));
      return res.json();
    },
    enabled: !!serverId && !!serverDomain,
    staleTime: 60_000,
  });

  const saveMutation = useMutation({
    mutationFn: async ({ key, provider, modelId }: { key: string; provider: string; modelId?: string }) => {
      const res = await fetchWithCodeToken(`${codeApiUrl}/api/zeroclaw/llm-key`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: key, ...(modelId && { modelId }) }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t("saveFailed", { status: res.status }));
      }
      return { hasKey: true, provider, modelId: modelId || null } as LlmKeyStatus;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
    },
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetchWithCodeToken(`${codeApiUrl}/api/zeroclaw/llm-key`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(t("removeFailed"));
      return { hasKey: false, provider: null, modelId: null } as LlmKeyStatus;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
    },
  });

  return {
    hasKey: data?.hasKey ?? false,
    provider: data?.provider ?? null,
    modelId: data?.modelId ?? null,
    isLoading,
    saveKey: (key: string, provider: string, modelId?: string) =>
      saveMutation.mutateAsync({ key, provider, modelId }),
    removeKey: removeMutation.mutateAsync,
    isSaving: saveMutation.isPending || removeMutation.isPending,
    saveError: saveMutation.error?.message ?? removeMutation.error?.message ?? null,
  };
}
