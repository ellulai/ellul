// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/chat/ComposerPendingTerminalContexts.tsx

import { useTranslations } from "use-intl";
import { cn } from "@shared/utils";
import {
  formatTerminalContextLabel,
  isTerminalContextExpired,
  type TerminalContextDraft,
} from "../lib/terminal-context";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";

interface ComposerPendingTerminalContextsProps {
  contexts: ReadonlyArray<TerminalContextDraft>;
  className?: string;
}

interface ComposerPendingTerminalContextChipProps {
  context: TerminalContextDraft;
}

export function ComposerPendingTerminalContextChip({
  context,
}: ComposerPendingTerminalContextChipProps) {
  const tChat = useTranslations("chat");
  const label = formatTerminalContextLabel(context);
  const expired = isTerminalContextExpired(context);
  const tooltipText = expired
    ? tChat("composerExtended.terminalContextExpired", { label })
    : context.text;

  return <TerminalContextInlineChip label={label} tooltipText={tooltipText} expired={expired} />;
}

export function ComposerPendingTerminalContexts(props: ComposerPendingTerminalContextsProps) {
  const { contexts, className } = props;
  if (contexts.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {contexts.map((context) => (
        <ComposerPendingTerminalContextChip key={context.id} context={context} />
      ))}
    </div>
  );
}
