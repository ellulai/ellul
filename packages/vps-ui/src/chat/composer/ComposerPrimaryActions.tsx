// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/chat/ComposerPrimaryActions.tsx

import { memo } from "react";
import { ChevronDownIcon, ChevronLeftIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { cn } from "@shared/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  compact: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}

export const formatPendingPrimaryActionLabel = (
  input: {
    compact: boolean;
    isLastQuestion: boolean;
    isResponding: boolean;
    questionIndex: number;
  },
  t: (key: string) => string,
) => {
  if (input.isResponding) {
    return t("primaryActions.submitting");
  }
  if (input.compact) {
    return input.isLastQuestion ? t("primaryActions.submit") : t("primaryActions.next");
  }
  if (!input.isLastQuestion) {
    return t("primaryActions.nextQuestion");
  }
  return input.questionIndex > 0
    ? t("primaryActions.submitAnswers")
    : t("primaryActions.submitAnswer");
};

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  isConnecting,
  isPreparingWorktree,
  hasSendableContent,
  onPreviousPendingQuestion,
  onInterrupt,
  onImplementPlanInNewThread,
}: ComposerPrimaryActionsProps) {
  const tChat = useTranslations("chat");
  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label={tChat("primaryActions.previousQuestionAria")}
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              {tChat("primaryActions.previous")}
            </Button>
          )
        ) : null}
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "px-3" : "px-4")}
          disabled={
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel(
            {
              compact,
              isLastQuestion: pendingAction.isLastQuestion,
              isResponding: pendingAction.isResponding,
              questionIndex: pendingAction.questionIndex,
            },
            tChat,
          )}
        </Button>
      </div>
    );
  }

  if (isRunning) {
    return (
      <button
        type="button"
        className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-rose-500/90 text-white transition-all duration-150 hover:bg-rose-500 hover:scale-105 sm:h-8 sm:w-8"
        onClick={onInterrupt}
        aria-label={tChat("primaryActions.stopGenerationAria")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </button>
    );
  }

  if (showPlanFollowUpPrompt) {
    if (promptHasText) {
      return (
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8")}
          disabled={isSendBusy || isConnecting}
        >
          {isConnecting || isSendBusy ? tChat("primaryActions.sending") : tChat("primaryActions.refine")}
        </Button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <Button
          type="submit"
          size="sm"
          className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
          disabled={isSendBusy || isConnecting}
        >
          {isConnecting || isSendBusy ? tChat("primaryActions.sending") : tChat("primaryActions.implement")}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="default"
                className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                aria-label={tChat("primaryActions.implementationActionsAria")}
                disabled={isSendBusy || isConnecting}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            <MenuItem
              disabled={isSendBusy || isConnecting}
              onClick={() => void onImplementPlanInNewThread()}
            >
              {tChat("primaryActions.implementInNewThread")}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  return (
    <button
      type="submit"
      className="flex h-9 w-9 enabled:cursor-pointer items-center justify-center rounded-full bg-primary/90 text-primary-foreground transition-all duration-150 hover:bg-primary hover:scale-105 disabled:pointer-events-none disabled:opacity-30 disabled:hover:scale-100 sm:h-8 sm:w-8"
      disabled={isSendBusy || isConnecting || !hasSendableContent}
      aria-label={
        isConnecting
          ? tChat("primaryActions.connectingAria")
          : isPreparingWorktree
            ? tChat("primaryActions.preparingWorktreeAria")
            : isSendBusy
              ? tChat("primaryActions.sendingAria")
              : tChat("primaryActions.sendMessageAria")
      }
    >
      {isConnecting || isSendBusy ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          className="animate-spin"
          aria-hidden="true"
        >
          <circle
            cx="7"
            cy="7"
            r="5.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray="20 12"
          />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
});
