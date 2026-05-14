// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { memo } from "react";
import { Loader2Icon, WifiOffIcon, CircleAlertIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { Alert, AlertDescription } from "../ui/alert";

export type ConnectionStatus = "connected" | "reconnecting" | "disconnected" | "error";

export interface ConnectionStatusBannerProps {
  status: ConnectionStatus;
  attempt?: number;
}

export const ConnectionStatusBanner = memo(function ConnectionStatusBanner({
  status,
  attempt,
}: ConnectionStatusBannerProps) {
  const tChat = useTranslations("chat");
  if (status === "connected") return null;

  const variant = status === "error" ? "error" : "warning";
  const Icon = status === "reconnecting" ? Loader2Icon : status === "disconnected" ? WifiOffIcon : CircleAlertIcon;
  const message =
    status === "reconnecting"
      ? attempt
        ? tChat("connection.reconnectingWithAttempt", { attempt })
        : tChat("connection.reconnecting")
      : status === "disconnected"
      ? tChat("connection.disconnectedShort")
      : tChat("connection.errorShort");

  return (
    <div className="pt-3 mx-auto max-w-3xl w-full">
      <Alert variant={variant}>
        <Icon className={status === "reconnecting" ? "size-4 animate-spin" : "size-4"} />
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </div>
  );
});
