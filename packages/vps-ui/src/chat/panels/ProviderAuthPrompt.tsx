// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Auth-prompt surface shown inline above the composer when the selected
// provider reports a non-ready status. Displays the adapter's auth message
// verbatim (e.g. "Codex CLI is not authenticated. Run `codex login` and
// try again.") plus a "Re-check" button that calls refreshProvider() on
// the bridge so the user can confirm their external auth step worked
// without waiting for the periodic server-side refresh.

import { memo } from "react";
import { CircleAlertIcon, KeyRoundIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { PROVIDER_DISPLAY_NAMES, type ProviderKind, type ServerProvider } from "@ellul.ai/types";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

export interface ProviderAuthPromptProps {
  readonly status: ServerProvider | null;
  readonly onRefresh: (provider: ProviderKind) => void | Promise<void>;
  readonly onStartAuth: (provider: ProviderKind) => void;
  readonly refreshing?: boolean;
  readonly verifying?: boolean;
}

const AUTH_FLOW_PROVIDERS: ReadonlySet<ProviderKind> = new Set<ProviderKind>([
  "claudeAgent",
  "codex",
  "cursor",
  "grokAgent",
]);

function commandForProvider(provider: ProviderKind): string | null {
  switch (provider) {
    case "claudeAgent":
      return "claude setup-token";
    case "codex":
      return "codex login";
    case "cursor":
      return "cursor-agent login";
    case "opencode":
      return null;
    case "zeroclaw":
      return null;
    case "grokAgent":
      return "grok login";
  }
}

export const ProviderAuthPrompt = memo(function ProviderAuthPrompt({
  status,
  onRefresh,
  onStartAuth,
  refreshing = false,
  verifying = false,
}: ProviderAuthPromptProps) {
  const tChat = useTranslations("chat");
  if (!status || status.status === "ready" || status.status === "disabled") return null;

  const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;

  if (verifying) {
    return (
      <div className="mx-auto w-full max-w-[52rem] px-3 pb-2 sm:px-5">
        <Alert>
          <Loader2Icon className="animate-spin" />
          <AlertTitle>{tChat("providerAuth.verifyingTitle", { provider: providerLabel })}</AlertTitle>
          <AlertDescription>
            <p className="text-sm leading-snug text-muted-foreground">
              {tChat("providerAuth.verifyingBody")}
            </p>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  const message =
    status.message ??
    (status.status === "error"
      ? tChat("providerAuth.providerUnavailable", { provider: providerLabel })
      : tChat("providerAuth.providerLimited", { provider: providerLabel }));
  const command = commandForProvider(status.provider);

  return (
    <div className="mx-auto w-full max-w-[52rem] px-3 pb-2 sm:px-5">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{tChat("providerAuth.notReady", { provider: providerLabel })}</AlertTitle>
        <AlertDescription className="space-y-2">
          <p className="whitespace-pre-wrap leading-snug">{message}</p>
          {command ? (
            <p className="text-xs text-muted-foreground">
              {tChat("providerAuth.runAndRecheck")}{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {command}
              </code>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-1">
            {AUTH_FLOW_PROVIDERS.has(status.provider) ? (
              <Button
                size="sm"
                variant="default"
                onClick={() => onStartAuth(status.provider)}
              >
                <KeyRoundIcon />
                {tChat("providerAuth.signInTo", { provider: providerLabel })}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={refreshing}
              onClick={() => void onRefresh(status.provider)}
            >
              <RefreshCwIcon className={refreshing ? "animate-spin" : ""} />
              {refreshing ? tChat("providerAuth.checking") : tChat("providerAuth.recheck")}
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
});
