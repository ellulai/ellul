// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { memo } from "react";
import { SparklesIcon, OctagonAlertIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { Alert, AlertDescription } from "../ui/alert";

export type SystemHealthState = "green" | "yellow" | "red";

export interface DegradationModeBannerProps {
  state: SystemHealthState;
}

export const DegradationModeBanner = memo(function DegradationModeBanner({ state }: DegradationModeBannerProps) {
  const tChat = useTranslations("chat");
  if (state === "green") return null;
  if (state === "yellow") {
    return (
      <div className="pt-3 mx-auto max-w-3xl w-full">
        <Alert variant="warning">
          <SparklesIcon className="size-4" />
          <AlertDescription>{tChat("system.autoTidy")}</AlertDescription>
        </Alert>
      </div>
    );
  }
  return (
    <div className="pt-3 mx-auto max-w-3xl w-full">
      <Alert variant="error">
        <OctagonAlertIcon className="size-4" />
        <AlertDescription>{tChat("system.degradedMode")}</AlertDescription>
      </Alert>
    </div>
  );
});
