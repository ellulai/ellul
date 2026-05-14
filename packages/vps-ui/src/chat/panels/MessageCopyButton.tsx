// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/chat/MessageCopyButton.tsx

import { memo, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { cn } from "@shared/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const RESET_MS = 1500;

export interface MessageCopyButtonProps {
  text: string;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  size = "xs",
  variant = "outline",
  className,
}: MessageCopyButtonProps) {
  const tChat = useTranslations("chat");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setError(null);
      setCopied(true);
      setTimeout(() => setCopied(false), RESET_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : tChat("copy.error"));
      setTimeout(() => setError(null), RESET_MS);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={tChat("copy.tooltip")}
            disabled={copied}
            onClick={onClick}
            type="button"
            size={size}
            variant={variant}
            className={cn("disabled:opacity-100", className)}
          />
        }
      >
        {copied ? (
          <CheckIcon className="size-3 text-sodium" />
        ) : (
          <CopyIcon className="size-3" />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        {error ? <p className="text-terra">{error}</p> : copied ? <p>{tChat("copy.copied")}</p> : <p>{tChat("copy.tooltip")}</p>}
      </TooltipPopup>
    </Tooltip>
  );
});
