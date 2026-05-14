// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { memo } from "react";
import { ClockIcon } from "lucide-react";
import { useTranslations } from "use-intl";

export interface QueuedSendPillProps {
  position: number;
  etaMs: number;
}

export const QueuedSendPill = memo(function QueuedSendPill({ position, etaMs }: QueuedSendPillProps) {
  const tChat = useTranslations("chat");
  const eta =
    etaMs >= 60_000
      ? tChat("queuedSend.minutes", { count: Math.round(etaMs / 60_000) })
      : tChat("queuedSend.seconds", { count: Math.round(etaMs / 1000) });
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
    >
      <ClockIcon className="size-3" />
      {tChat("queuedSend.label", { position: position + 1, eta })}
    </span>
  );
});
