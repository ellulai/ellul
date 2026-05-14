// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/chat/ProviderStatusBanner.tsx

import { memo } from "react";
import { CircleAlertIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@ellul.ai/types";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

export interface ProviderStatusBannerProps {
  status: ServerProvider | null;
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: ProviderStatusBannerProps) {
  const tChat = useTranslations("chat");
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;
  const defaultMessage =
    status.status === "error"
      ? tChat("providerStatus.providerUnavailable", { provider: providerLabel })
      : tChat("providerStatus.providerLimited", { provider: providerLabel });
  const title = tChat("providerStatus.title", { provider: providerLabel });

  return (
    <div className="pt-3 mx-auto max-w-3xl w-full">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
      </Alert>
    </div>
  );
});
