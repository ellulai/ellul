// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/chat/ComposerPlanFollowUpBanner.tsx

import { memo } from "react";
import { useTranslations } from "use-intl";

export const ComposerPlanFollowUpBanner = memo(function ComposerPlanFollowUpBanner({
  planTitle,
}: {
  planTitle: string | null;
}) {
  const tChat = useTranslations("chat");
  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">{tChat("composerExtended.planReady")}</span>
        {planTitle ? (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{planTitle}</span>
        ) : null}
      </div>
    </div>
  );
});
