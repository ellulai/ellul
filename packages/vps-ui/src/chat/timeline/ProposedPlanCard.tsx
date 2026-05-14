// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/chat/ProposedPlanCard.tsx
//
// Minimal port: drops the Menu/Input/Dialog save-to-workspace flow and the
// toastManager / readEnvironmentApi deps. Copy + download still land here;
// save-to-workspace is deferred to a follow-up when we port the Menu+toast
// primitives.

import { memo, useState } from "react";
import type { EnvironmentId } from "@ellul.ai/types";
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../proposedPlan";
import { cn } from "../../shared/utils";
import { Button } from "../ui/button";
import { ChatMarkdown } from "../panels/ChatMarkdown";

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  cwd,
}: {
  planMarkdown: string;
  environmentId?: EnvironmentId;
  cwd: string | undefined;
  workspaceRoot?: string | undefined;
}) {
  const tChat = useTranslations("chat");
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const title = proposedPlanTitle(planMarkdown) ?? tChat("proposedPlan.fallbackTitle");
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(saveContents);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fall through; no toast in this minimal port
    }
  };

  return (
    <div className="rounded-[24px] border border-popover/80 bg-popover/40 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded bg-sodium/15 px-2 py-0.5 text-xs font-medium text-sodium">
            {tChat("proposedPlan.planLabel")}
          </span>
          <p className="truncate text-sm font-medium text-ink">{title}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={copied ? tChat("proposedPlan.copied") : tChat("proposedPlan.copy")}
            title={copied ? tChat("proposedPlan.copied") : tChat("proposedPlan.copy")}
            onClick={() => void handleCopy()}
          >
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </Button>
          <Button
            size="icon-xs"
            variant="outline"
            aria-label={tChat("proposedPlan.downloadAria")}
            title={tChat("proposedPlan.downloadAria")}
            onClick={handleDownload}
          >
            <DownloadIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="mt-4">
        <div className={cn("relative", canCollapse && !expanded && "max-h-104 overflow-hidden")}>
          {canCollapse && !expanded ? (
            <ChatMarkdown text={collapsedPreview ?? ""} cwd={cwd} isStreaming={false} />
          ) : (
            <ChatMarkdown text={displayedPlanMarkdown} cwd={cwd} isStreaming={false} />
          )}
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-popover/95 via-popover/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? tChat("proposedPlan.collapse") : tChat("proposedPlan.expand")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
});
