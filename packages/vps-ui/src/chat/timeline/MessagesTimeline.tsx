// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/chat/MessagesTimeline.tsx
//
// Upstream `useUiStateStore` binding replaced with local useState —
// Ellul doesn't persist per-thread changed-files expansion state.

import type { EnvironmentId, MessageId, TurnId } from "@ellul.ai/types";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useTranslations } from "use-intl";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  RefreshCwIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";

import type { ChatMessage, TurnDiffSummary, TimestampFormat } from "@ellul.ai/types";
import { deriveTimelineEntries, formatElapsed } from "../lib/session-logic";
import { summarizeTurnDiffStats } from "../lib/turn-diff-tree";
import { formatTimestamp } from "../lib/timestamp-format";
import { formatWorkspaceRelativePath } from "../lib/file-path-display";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "../lib/terminal-context";
import { cn } from "../../shared/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ChangedFilesTree } from "../diff/ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "../diff/DiffStatLabel";
import { MessageCopyButton } from "../panels/MessageCopyButton";
import {
  buildExpandedImagePreview,
  type ExpandedImagePreview,
} from "../dialogs/ExpandedImagePreview";
import { ChatMarkdown } from "../panels/ChatMarkdown";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { TerminalContextInlineChip } from "../composer/TerminalContextInlineChip";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./user-message-terminal-contexts";
import {
  computeStableMessagesTimelineRows,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
} from "./logic";

interface TimelineRowSharedState {
  activeTurnInProgress: boolean;
  activeTurnId: TurnId | null | undefined;
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  completionSummary: string | null;
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  activeThreadEnvironmentId: EnvironmentId;
  failedMessageIds: Set<string>;
  onRetryMessage: (messageId: string) => void;
  onRevertUserMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);

interface MessagesTimelineProps {
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  failedMessageIds: Set<string>;
  onRetryMessage: (messageId: string) => void;
  onIsAtEndChange: (isAtEnd: boolean) => void;
}

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  activeTurnInProgress,
  activeTurnId,
  activeTurnStartedAt,
  listRef,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  failedMessageIds,
  onRetryMessage,
  onIsAtEndChange,
}: MessagesTimelineProps) {
  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        isWorking,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      completionDividerBeforeEntryId,
      isWorking,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (state) {
      onIsAtEndChange(state.isAtEnd);
    }
  }, [listRef, onIsAtEndChange]);

  const previousRowCountRef = useRef(rows.length);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;

    if (previousRowCount > 0 || rows.length === 0) return;

    onIsAtEndChange(true);
    const frameId = window.requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd?.({ animated: false });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [listRef, onIsAtEndChange, rows.length]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      activeTurnInProgress,
      activeTurnId: activeTurnId ?? null,
      isWorking,
      isRevertingCheckpoint,
      completionSummary,
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      activeThreadEnvironmentId,
      failedMessageIds,
      onRetryMessage,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
    }),
    [
      activeTurnInProgress,
      activeTurnId,
      isWorking,
      isRevertingCheckpoint,
      completionSummary,
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      activeThreadEnvironmentId,
      failedMessageIds,
      onRetryMessage,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
    ],
  );

  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
    return <EmptyTimelineMessage />;
  }

  return (
    <TimelineRowCtx.Provider value={sharedState}>
      <LegendList<MessagesTimelineRow>
        ref={listRef}
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        estimatedItemSize={90}
        initialScrollAtEnd
        maintainScrollAtEnd
        maintainScrollAtEndThreshold={0.1}
        maintainVisibleContentPosition
        onScroll={handleScroll}
        className="h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
        ListHeaderComponent={<div className="h-3 sm:h-4" />}
        ListFooterComponent={<div className="h-3 sm:h-4" />}
      />
    </TimelineRowCtx.Provider>
  );
});

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

function EmptyTimelineMessage() {
  const tChat = useTranslations("chat");
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-muted-foreground/30">
        {tChat("messagesTimeline.emptyStartConversation")}
      </p>
    </div>
  );
}

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

function TimelineRowContent({ row }: { row: TimelineRow }) {
  const ctx = use(TimelineRowCtx);
  const tChat = useTranslations("chat");

  return (
    <div
      className={cn(
        "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" && <WorkGroupSection groupedEntries={row.groupedEntries} />}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = row.message.attachments ?? [];
          const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
          const terminalContexts = displayedUserMessage.contexts;
          const canRevertAgentWork = typeof row.revertTurnCount === "number";
          const isFailed = ctx.failedMessageIds.has(row.message.id);
          return (
            <div className="flex justify-end">
              <div className={cn(
                "group relative max-w-[min(80%,38rem)] rounded-2xl rounded-br-sm border px-4 py-3",
                isFailed ? "border-destructive/50 bg-destructive/5" : "border-border bg-secondary",
              )}>
                {userImages.length > 0 && (
                  <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                    {userImages.map(
                      (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                        <div
                          key={image.id}
                          className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
                        >
                          {image.previewUrl ? (
                            <button
                              type="button"
                              className="h-full w-full cursor-zoom-in"
                              aria-label={tChat("messagesTimeline.previewImageAria", { name: image.name })}
                              onClick={() => {
                                const preview = buildExpandedImagePreview(userImages, image.id);
                                if (!preview) return;
                                ctx.onImageExpand(preview);
                              }}
                            >
                              <img
                                src={image.previewUrl}
                                alt={image.name}
                                className="block h-auto max-h-[220px] w-full object-cover"
                              />
                            </button>
                          ) : (
                            <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                              {image.name}
                            </div>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                )}
                {(displayedUserMessage.visibleText.trim().length > 0 ||
                  terminalContexts.length > 0) && (
                  <UserMessageBody
                    text={displayedUserMessage.visibleText}
                    terminalContexts={terminalContexts}
                  />
                )}
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  {isFailed && (
                    <button
                      type="button"
                      className="flex items-center gap-1 text-[11px] text-destructive hover:text-destructive/80 transition-colors"
                      onClick={() => ctx.onRetryMessage(row.message.id)}
                      aria-label={tChat("messagesTimeline.retryAria")}
                    >
                      <CircleAlertIcon className="size-3" />
                      <span>{tChat("messagesTimeline.sendFailed")}</span>
                      <RefreshCwIcon className="size-3 ml-0.5" />
                    </button>
                  )}
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {displayedUserMessage.copyText && (
                      <MessageCopyButton text={displayedUserMessage.copyText} />
                    )}
                    {canRevertAgentWork && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={ctx.isRevertingCheckpoint || ctx.isWorking}
                        onClick={() => ctx.onRevertUserMessage(row.message.id)}
                        title={tChat("messagesTimeline.revertToMessageTitle")}
                      >
                        <Undo2Icon className="size-3" />
                      </Button>
                    )}
                  </div>
                  <p className="text-right text-xs text-muted-foreground/50">
                    {formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : tChat("messagesTimeline.emptyResponse"));
          const assistantTurnStillInProgress =
            ctx.activeTurnInProgress &&
            ctx.activeTurnId !== null &&
            ctx.activeTurnId !== undefined &&
            row.message.turnId === ctx.activeTurnId;
          const assistantCopyState = resolveAssistantMessageCopyState({
            text: row.message.text ?? null,
            showCopyButton: row.showAssistantCopyButton,
            streaming: row.message.streaming || assistantTurnStillInProgress,
          });
          return (
            <>
              {row.showCompletionDivider && (
                <div className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                    {ctx.completionSummary
                      ? tChat("messagesTimeline.responseWithSummary", { summary: ctx.completionSummary })
                      : tChat("messagesTimeline.responseLabel")}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className="min-w-0 px-1 py-0.5">
                <ChatMarkdown
                  text={messageText}
                  cwd={ctx.markdownCwd}
                  isStreaming={Boolean(row.message.streaming)}
                />
                <AssistantChangedFilesSection
                  turnSummary={row.assistantTurnDiffSummary}
                  routeThreadKey={ctx.routeThreadKey}
                  resolvedTheme={ctx.resolvedTheme}
                  onOpenTurnDiff={ctx.onOpenTurnDiff}
                />
                <div className="mt-1.5 flex items-center gap-2">
                  <p className="text-[10px] text-muted-foreground/30">
                    {row.message.streaming ? (
                      <LiveMessageMeta
                        createdAt={row.message.createdAt}
                        durationStart={row.durationStart}
                        timestampFormat={ctx.timestampFormat}
                      />
                    ) : (
                      formatMessageMeta(
                        row.message.createdAt,
                        formatElapsed(row.durationStart, row.message.completedAt),
                        ctx.timestampFormat,
                      )
                    )}
                  </p>
                  {assistantCopyState.visible ? (
                    <div className="flex items-center opacity-0 transition-opacity duration-200  group-hover/assistant:opacity-100">
                      <MessageCopyButton
                        text={assistantCopyState.text ?? ""}
                        size="icon-xs"
                        variant="outline"
                        className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          );
        })()}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            environmentId={ctx.activeThreadEnvironmentId}
            cwd={ctx.markdownCwd}
            workspaceRoot={ctx.workspaceRoot}
          />
        </div>
      )}

      {row.kind === "working" && (
        <div className="py-0.5 pl-1.5">
          <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70">
            <span className="inline-flex items-center gap-[3px]">
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
              <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
            </span>
            <span>
              {row.createdAt ? (
                <>
                  {tChat("messagesTimeline.workingFor")} <WorkingTimer createdAt={row.createdAt} />
                </>
              ) : (
                tChat("messagesTimeline.workingFallback")
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkingTimer({ createdAt }: { createdAt: string }) {
  const tChat = useTranslations("chat");
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [createdAt]);
  return <>{formatWorkingTimer(createdAt, new Date(nowMs).toISOString()) ?? tChat("messagesTimeline.workingZeroSeconds")}</>;
}

function LiveMessageMeta({
  createdAt,
  durationStart,
  timestampFormat,
}: {
  createdAt: string;
  durationStart: string | null | undefined;
  timestampFormat: TimestampFormat;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [durationStart]);
  const elapsed = durationStart
    ? formatElapsed(durationStart, new Date(nowMs).toISOString())
    : null;
  return <>{formatMessageMeta(createdAt, elapsed, timestampFormat)}</>;
}

const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
}) {
  const { workspaceRoot } = use(TimelineRowCtx);
  const tChat = useTranslations("chat");
  const [isExpanded, setIsExpanded] = useState(false);
  const hasOverflow = groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : groupedEntries;
  const hiddenCount = groupedEntries.length - visibleEntries.length;
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  const showHeader = hasOverflow || !onlyToolEntries;
  const groupLabel = onlyToolEntries
    ? tChat("messagesTimeline.toolCallsHeader")
    : tChat("messagesTimeline.workLogHeader");

  return (
    <div className="rounded-xl border border-border/45 bg-card/25 px-2 py-1.5">
      {showHeader && (
        <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
          <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
            {tChat("messagesTimeline.groupCount", { label: groupLabel, count: groupedEntries.length })}
          </p>
          {hasOverflow && (
            <button
              type="button"
              className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
              onClick={() => setIsExpanded((v) => !v)}
            >
              {isExpanded
                ? tChat("messagesTimeline.showLess")
                : tChat("messagesTimeline.showMore", { count: hiddenCount })}
            </button>
          )}
        </div>
      )}
      <div className="space-y-0.5">
        {visibleEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={`work-row:${workEntry.id}`}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
    </div>
  );
});

const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const tChat = useTranslations("chat");
  const [allDirectoriesExpanded, setAllDirectoriesExpanded] = useState(true);
  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const changedFileCount = checkpointFiles.length;

  return (
    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
          <span>{tChat("messagesTimeline.changedFiles", { count: changedFileCount })}</span>
          {hasNonZeroStat(summaryStat) && (
            <>
              <span className="mx-1">•</span>
              <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
            </>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-scroll-anchor-ignore
            onClick={() => setAllDirectoriesExpanded((v) => !v)}
          >
            {allDirectoriesExpanded ? tChat("messagesTimeline.collapseAll") : tChat("messagesTimeline.expandAll")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)}
          >
            {tChat("messagesTimeline.viewDiff")}
          </Button>
        </div>
      </div>
      <ChangedFilesTree
        key={`changed-files-tree:${turnSummary.turnId}`}
        turnId={turnSummary.turnId}
        files={checkpointFiles}
        allDirectoriesExpanded={allDirectoriesExpanded}
        resolvedTheme={resolvedTheme}
        onOpenTurnDiff={(turnId, filePath) => onOpenTurnDiff(turnId as TurnId, filePath)}
      />
    </div>
  );
}

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(<span key="user-message-terminal-context-inline-text">{props.text}</span>);
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
      {props.text}
    </div>
  );
});

function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return null;

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") return { icon: CircleAlertIcon, className: "text-foreground/92" };
  if (tone === "thinking") return { icon: BotIcon, className: "text-foreground/92" };
  if (tone === "info") return { icon: CheckIcon, className: "text-foreground/92" };
  return { icon: ZapIcon, className: "text-foreground/92" };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) return null;
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) return TerminalIcon;
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const rawCommand = workEntryRawCommand(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;

  return (
    <div className="rounded-lg px-1 py-1">
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          {rawCommand ? (
            <div className="max-w-full">
              <p
                className={cn(
                  "truncate text-xs leading-5",
                  workToneClass(workEntry.tone),
                  preview ? "text-muted-foreground/70" : "",
                )}
                title={displayText}
              >
                <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                  {heading}
                </span>
                {preview && (
                  <Tooltip>
                    <TooltipTrigger
                      closeDelay={0}
                      delay={75}
                      render={
                        <span className="max-w-full cursor-default text-muted-foreground/55 transition-colors hover:text-muted-foreground/75 focus-visible:text-muted-foreground/75">
                          {" "}
                          - {preview}
                        </span>
                      }
                    />
                    <TooltipPopup
                      align="start"
                      className="max-w-[min(56rem,calc(100vw-2rem))] px-0 py-0"
                      side="top"
                    >
                      <div className="max-w-[min(56rem,calc(100vw-2rem))] overflow-x-auto px-1.5 py-1 font-mono text-[11px] leading-4 whitespace-nowrap">
                        {rawCommand}
                      </div>
                    </TooltipPopup>
                  </Tooltip>
                )}
              </p>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger
                className="block min-w-0 w-full text-left"
                title={displayText}
                aria-label={displayText}
              >
                <p
                  className={cn(
                    "truncate text-[11px] leading-5",
                    workToneClass(workEntry.tone),
                    preview ? "text-muted-foreground/70" : "",
                  )}
                >
                  <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                    {heading}
                  </span>
                  {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
                </p>
              </TooltipTrigger>
              <TooltipPopup className="max-w-[min(720px,calc(100vw-2rem))]">
                <p className="whitespace-pre-wrap break-words text-xs leading-5">{displayText}</p>
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
            return (
              <span
                key={`${workEntry.id}:${filePath}`}
                className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
                title={displayPath}
              >
                {displayPath}
              </span>
            );
          })}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
