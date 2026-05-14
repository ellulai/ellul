export * from "./ids";
export * from "./environment";
export * from "./project";
export * from "./provider";
export * from "./orchestration";
export * from "./chat";
export * from "./model";
export * from "./git";
export * from "./keybindings";
export * from "./settings";

export type {
  WorkspaceConfigV1,
  WorkspaceContextConfig,
  WorkspaceTabEntry,
} from "./workspace";

export type {
  SecurityTier,
  ServerPlan,
} from "./product";

export type {
  GateType,
  GatePermission,
} from "./gate";

export type {
  DeploymentStatus,
  ProviderCapabilities,
} from "./integration";

export type {
  OrphanReason,
  PreviewPhase,
  ProbeHealthState,
  PreviewHealthResult,
  PreviewProbeResult,
  PreviewLifecyclePhase,
  PreviewLifecycleEvent,
} from "./preview";

export { CANONICAL_PREVIEW_PHASES } from "./preview";

export type {
  ActionContext,
  ActionContextKind,
  ActionSelectionKind,
  ActionSeverity,
  ChatAction,
  ConnectionHealth,
  IntegrationCategory,
  IntegrationConnection,
  IntegrationState,
  IntegrationsResponse,
  ResolvedAction,
} from "./integrations";

// Canonical security scope — SandboxId. Every security surface imports from
// here. See `scope.ts` for the invariants and rationale.
export {
  SANDBOX_ID_RE,
  SandboxIdSchema,
  InvalidSandboxIdError,
  ScopeMismatchError,
  isSandboxId,
  parseSandboxId,
  tryParseSandboxId,
  assertSandboxId,
  sandboxIdFromPath,
  sandboxIdFromCwd,
} from "./scope";
export type { SandboxId } from "./scope";

// Canonical message-part taxonomy — shared by agent-bridge backend and
// vps-ui chat iframe. Mirrors OpenCode's native Part shape.
export type {
  MessagePart,
  MessagePartType,
  MessageToolStatus,
  MessageTextPart,
  MessageReasoningPart,
  MessageToolPart,
  MessageFilePart,
  MessagePlanPart,
  MessageStepMarkerPart,
  CanonicalToolKind,
  ToolOutputKind,
  PlanStep,
  PlanStepStatus,
} from "./message-part";
export {
  SAFE_FILE_URL_SCHEMES,
  isSafeFileUrl,
  deriveContentFromParts,
} from "./message-part";

export type {
  ThreadCliOptions,
  CodexOptions,
  ClaudeOptions,
  OpenCodeOptions,
  CursorOptions,
  ClaudeEffort,
  InteractionMode,
} from "./cli-options";
export {
  CLAUDE_EFFORT_OPTIONS,
  INTERACTION_MODES,
  RUNTIME_MODES,
  EFFORT_LEVELS_BY_PROVIDER,
  isClaudeEffort,
} from "./cli-options";

export type { ModelBadge } from "./model-catalog";
export {
  CLAUDE_MODELS,
  CODEX_MODELS,
  CURSOR_MODELS,
  OPENCODE_MODELS,
  MODELS_BY_PROVIDER,
  getModelCapabilities,
  defaultModelFor,
} from "./model-catalog";
