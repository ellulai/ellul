// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/chat/ThreadErrorBanner.tsx

import { memo } from "react";
import { CircleAlertIcon, XIcon, ExternalLinkIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";

export interface ThreadErrorBannerProps {
  error: string | null;
  errorCode?: string | null;
  onDismiss?: () => void;
}

function getRunbookBase(): string {
  const zone = window.__ELLUL_CONFIG__?.platformZone;
  if (!zone) return "";
  return `https://docs.${zone}/runbooks/`;
}

// Stable mapping from server-emitted error codes to translation keys under
// `chat.threadError.friendly.*`. Codes themselves are infrastructure (logs,
// runbooks, support tickets) and stay literal English. Friendly prose flips
// per locale.
const FRIENDLY_MESSAGE_KEY: Record<string, string> = {
  ERR_ADMISSION_NO_HEADROOM: "noHeadroom",
  ERR_ADMISSION_TIER_CAP: "tierCap",
  ERR_ADMISSION_DEGRADED_RED: "degradedRed",
  ERR_ADMISSION_PRESSURE_HIGH: "pressureHigh",
  ERR_ADMISSION_FRAMEWORK_TOO_BIG: "frameworkTooBig",
  ERR_QUEUE_FULL: "queueFull",
  ERR_SLOT_HYDRATE_FAILED: "slotHydrateFailed",
  ERR_SLOT_SPAWN_FAILED: "slotSpawnFailed",
  ERR_SLOT_EVICT_TIMEOUT: "slotEvictTimeout",
  ERR_SPAWN_SCOPE_BINARY_MISSING: "spawnScopeBinaryMissing",
  ERR_PORT_BIND_TIMEOUT: "portBindTimeout",
  ERR_CHECKPOINT_DISK_FULL: "checkpointDiskFull",
  ERR_CGROUPV2_NOT_MOUNTED: "cgroupv2NotMounted",
};

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  errorCode,
  onDismiss,
}: ThreadErrorBannerProps) {
  const tChat = useTranslations("chat");
  if (!error && !errorCode) return null;
  let display: string;
  if (errorCode) {
    const key = FRIENDLY_MESSAGE_KEY[errorCode];
    display = key
      ? tChat(`threadError.friendly.${key}` as `threadError.friendly.${string}`)
      : (error ?? errorCode);
  } else {
    display = error ?? "";
  }
  return (
    <div className="pt-3 mx-auto max-w-3xl w-full">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription className="line-clamp-3" title={errorCode ?? display}>
          <span>{display}</span>
          {errorCode && (
            <a
              href={`${getRunbookBase()}${errorCode}`}
              target="_blank"
              rel="noreferrer"
              className="ml-2 inline-flex items-center gap-1 text-xs text-destructive/80 underline-offset-2 hover:underline"
            >
              {errorCode} <ExternalLinkIcon className="size-3" />
            </a>
          )}
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <button
              type="button"
              aria-label={tChat("threadError.dismissAria")}
              className="inline-flex size-6 items-center justify-center rounded-md text-destructive/60 transition-colors hover:text-destructive"
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
