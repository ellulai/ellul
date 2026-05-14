// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx

import { memo } from "react";
import { useTranslations } from "use-intl";
import { type PendingApproval } from "../lib/session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const tChat = useTranslations("chat");
  const approvalSummary =
    approval.requestKind === "command"
      ? tChat("approval.command")
      : approval.requestKind === "file-read"
        ? tChat("approval.fileRead")
        : tChat("approval.fileChange");

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">{tChat("approval.pendingHeading")}</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
    </div>
  );
});
