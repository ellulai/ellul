// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  FileText,
  Save,
  RefreshCw,
  ArrowLeft,
  Pencil,
  Eye,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useClawWorkspace, type WorkspaceFile } from "@/hooks/useClawWorkspace";

interface ClawCoreFilesProps {
  serverDomain: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function ClawCoreFiles({ serverDomain }: ClawCoreFilesProps) {
  const t = useTranslations("console.clawCoreFiles");
  const formatDate = (iso: string): string => {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return t("today");
    if (days === 1) return t("oneDayAgo");
    if (days < 30) return t("daysAgo", { count: days });
    return d.toLocaleDateString();
  };
  const { files, isLoading, isSaving, error, fetchFiles, fetchFileContent, saveFile } =
    useClawWorkspace(serverDomain);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const openFile = useCallback(
    async (name: string) => {
      setSelectedFile(name);
      setIsEditing(false);
      const text = await fetchFileContent(name);
      if (text !== null) {
        setContent(text);
        setOriginalContent(text);
      } else {
        setContent("// Could not load file");
        setOriginalContent("");
      }
    },
    [fetchFileContent]
  );

  const handleSave = async () => {
    if (!selectedFile) return;
    const ok = await saveFile(selectedFile, content);
    if (ok) {
      setOriginalContent(content);
      setIsEditing(false);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } else {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  };

  const hasChanges = content !== originalContent;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner delay={300} />
      </div>
    );
  }

  // Detail view — editing a file
  if (selectedFile) {
    return (
      <div className="flex-1 flex flex-col min-h-0 panel-ascente">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-cream/[0.06]">
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setSelectedFile(null);
                setIsEditing(false);
              }}
              className="p-1 rounded hover:bg-cream/[0.06] text-cream/60 hover:text-cream transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <FileText className="h-4 w-4 text-sodium" />
            <span className="text-sm font-medium text-cream">{selectedFile}</span>
            {saveStatus === "saved" && (
              <span className="flex items-center gap-1 text-[10px] text-sodium">
                <Check className="h-2.5 w-2.5" />
                {t("saved")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {!isEditing ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setIsEditing(true)}
                className="h-7 text-xs border-cream/[0.08]"
              >
                <Pencil className="h-3 w-3 mr-1" />
                {t("edit")}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setContent(originalContent);
                    setIsEditing(false);
                  }}
                  className="h-7 text-xs border-cream/[0.08]"
                >
                  {t("cancel")}
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving || !hasChanges}
                  className="h-7 text-xs bg-sodium hover:bg-sodium"
                >
                  {isSaving ? (
                    <Spinner size="sm" />
                  ) : (
                    <>
                      <Save className="h-3 w-3 mr-1" />
                      {t("save")}
                    </>
                  )}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {isEditing ? (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full h-full min-h-[300px] p-4 bg-transparent text-sm text-cream/85 font-mono resize-none focus:outline-none"
              spellCheck={false}
            />
          ) : (
            <pre className="p-4 text-sm text-cream/75 font-mono whitespace-pre-wrap break-words">
              {content}
            </pre>
          )}
        </div>
      </div>
    );
  }

  // List view
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 pb-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-medium text-cream mb-1">{t("title")}</h2>
            <p className="text-sm text-cream/60">
              {t("subtitle")}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={fetchFiles}
            className="h-7 text-xs border-cream/[0.08]"
          >
            <RefreshCw className="h-3 w-3 mr-1" />
            {t("refresh")}
          </Button>
        </div>
        {error && <p className="text-xs text-terra mt-2">{error}</p>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {files.length === 0 ? (
          <div className="text-center py-8">
            <FileText className="h-8 w-8 text-cream/35 mx-auto mb-2" />
            <p className="text-sm text-cream/60">{t("noFiles")}</p>
            <p className="text-xs text-cream/45 mt-1">
              {t("noFilesHint")}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {files.map((file) => (
              <button
                key={file.name}
                onClick={() => openFile(file.name)}
                className="w-full flex items-center justify-between p-3 rounded-lg border border-cream/[0.06] bg-cream/[0.02] hover:bg-cream/[0.04] transition-colors text-left"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="h-4 w-4 text-sodium shrink-0" />
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-cream block">{file.name}</span>
                    <span className="text-[10px] text-cream/45">
                      {formatSize(file.size)} &middot; {formatDate(file.modified)}
                    </span>
                  </div>
                </div>
                <Eye className="h-3.5 w-3.5 text-cream/45 shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
