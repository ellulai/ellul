// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { memo } from "react";
import { CheckCircle2Icon, Loader2Icon, MoonIcon, OctagonAlertIcon } from "lucide-react";
import { useTranslations } from "use-intl";

export type PreviewState = "ready" | "starting" | "sleeping" | "failed";

export interface PreviewStatusPillProps {
  state: PreviewState;
  appDirectory: string;
  errorCode?: string | null;
}

const STYLE_BY_STATE: Record<PreviewState, { cls: string; Icon: typeof CheckCircle2Icon }> = {
  ready: { cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200", Icon: CheckCircle2Icon },
  starting: { cls: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200", Icon: Loader2Icon },
  sleeping: { cls: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300", Icon: MoonIcon },
  failed: { cls: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200", Icon: OctagonAlertIcon },
};

export const PreviewStatusPill = memo(function PreviewStatusPill({ state, appDirectory, errorCode }: PreviewStatusPillProps) {
  const tCB = useTranslations("codeBrowser");
  const c = STYLE_BY_STATE[state];
  const label = tCB(`previewStatus.${state}` as `previewStatus.${PreviewState}`);
  const title = `${appDirectory}${errorCode ? ` — ${errorCode}` : ""}`;
  return (
    <span
      role="status"
      aria-live="polite"
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${c.cls}`}
    >
      <c.Icon className={state === "starting" ? "size-3 animate-spin" : "size-3"} />
      {label}
    </span>
  );
});
