// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { getCodeApiUrl } from "@/lib/domains";
import { useCodeToken } from "@/contexts/CodeTokenContext";

export interface WorkspaceFile {
  name: string;
  size: number;
  modified: string;
  preview: string;
}

export function useClawWorkspace(serverDomain: string) {
  const t = useTranslations("console.hooks.clawWorkspace");
  const codeApiUrl = getCodeApiUrl(serverDomain);
  const { fetchWithCodeToken } = useCodeToken();
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFiles = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetchWithCodeToken(`${codeApiUrl}/api/zeroclaw/workspace`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch workspace files");
      const data = await res.json();
      setFiles(data.files || []);
      setError(null);
    } catch (e) {
      setError(t("loadFailed"));
    } finally {
      setIsLoading(false);
    }
  }, [codeApiUrl, fetchWithCodeToken, t]);

  const fetchFileContent = useCallback(
    async (fileName: string): Promise<string | null> => {
      try {
        const res = await fetchWithCodeToken(
          `${codeApiUrl}/api/zeroclaw/workspace?file=${encodeURIComponent(fileName)}`,
          { credentials: "include" }
        );
        if (!res.ok) return null;
        const data = await res.json();
        return data.content ?? null;
      } catch {
        return null;
      }
    },
    [codeApiUrl, fetchWithCodeToken]
  );

  const saveFile = useCallback(
    async (fileName: string, content: string): Promise<boolean> => {
      setIsSaving(true);
      try {
        const res = await fetchWithCodeToken(`${codeApiUrl}/api/zeroclaw/workspace`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: fileName, content }),
        });
        if (!res.ok) throw new Error("Failed to save file");
        await fetchFiles();
        return true;
      } catch {
        setError(t("saveFailed"));
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [codeApiUrl, fetchWithCodeToken, fetchFiles, t]
  );

  return {
    files,
    isLoading,
    isSaving,
    error,
    fetchFiles,
    fetchFileContent,
    saveFile,
  };
}
