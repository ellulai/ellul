// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/types.ts

import type { EnvironmentId, MessageId, ProjectId, ThreadId, TurnId } from "../ids";
import type { ModelSelection } from "../model/selection";
import type {
  ProviderInteractionMode,
  ProviderKind,
  RuntimeMode,
} from "../provider";
import type { OrchestrationProposedPlanId } from "../orchestration/proposed-plan";
import type { OrchestrationSessionStatus } from "../orchestration/session";
import type { OrchestrationThreadActivity } from "../orchestration/activity";
import type { OrchestrationLatestTurn } from "../orchestration/thread";
import type { ProjectScript } from "../orchestration/project";
import type { RepositoryIdentity } from "../environment";
import type { ChatAttachment } from "./attachment";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";

export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const DEFAULT_THREAD_TERMINAL_ID = "default";
export const MAX_TERMINALS_PER_GROUP = 4;

export interface ThreadTerminalGroup {
  id: string;
  terminalIds: string[];
}

export interface ChatMessage {
  id: MessageId;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ChatAttachment[];
  turnId?: TurnId | null;
  createdAt: string;
  completedAt?: string | undefined;
  streaming: boolean;
}

export interface ProposedPlan {
  id: OrchestrationProposedPlanId;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
  createdAt: string;
  updatedAt: string;
}

export interface TurnDiffFileChange {
  path: string;
  kind?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface TurnDiffSummary {
  turnId: TurnId;
  completedAt: string;
  status?: string | undefined;
  files: TurnDiffFileChange[];
  checkpointRef?: string | undefined;
  assistantMessageId?: MessageId | undefined;
  checkpointTurnCount?: number | undefined;
}

export interface ThreadSession {
  provider: ProviderKind;
  status: SessionPhase | "error" | "closed";
  activeTurnId?: TurnId | undefined;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  orchestrationStatus: OrchestrationSessionStatus;
}

export interface Project {
  id: ProjectId;
  environmentId: EnvironmentId;
  name: string;
  cwd: string;
  repositoryIdentity?: RepositoryIdentity | null;
  defaultModelSelection: ModelSelection | null;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  scripts: ProjectScript[];
}

export interface Thread {
  id: ThreadId;
  environmentId: EnvironmentId;
  codexThreadId: string | null;
  projectId: ProjectId;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  messages: ChatMessage[];
  proposedPlans: ProposedPlan[];
  error: string | null;
  createdAt: string;
  archivedAt: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  pendingSourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
  branch: string | null;
  worktreePath: string | null;
  turnDiffSummaries: TurnDiffSummary[];
  activities: OrchestrationThreadActivity[];
}

export interface ThreadShell {
  id: ThreadId;
  environmentId: EnvironmentId;
  codexThreadId: string | null;
  projectId: ProjectId;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  error: string | null;
  createdAt: string;
  archivedAt: string | null;
  updatedAt?: string | undefined;
  branch: string | null;
  worktreePath: string | null;
}

export interface ThreadTurnState {
  latestTurn: OrchestrationLatestTurn | null;
  pendingSourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
}

export interface SidebarThreadSummary {
  id: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  title: string;
  interactionMode: ProviderInteractionMode;
  modelSelection: ModelSelection;
  session: ThreadSession | null;
  createdAt: string;
  archivedAt: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  branch: string | null;
  worktreePath: string | null;
  viewScope: string | null;
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
}
