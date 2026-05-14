// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from pingdotgg/t3code@b0b7b38

export {
  OpenCodeAdapter,
  OpenCodeAdapterLive,
  makeOpenCodeAdapterLive,
  mergeOpenCodeAssistantText,
  appendOpenCodeAssistantTextDelta,
  type OpenCodeAdapterShape,
  type OpenCodeAdapterLiveOptions,
} from "./adapter";

export {
  OpenCodeRuntime,
  OpenCodeRuntimeLive,
  OpenCodeRuntimeError,
  openCodeRuntimeErrorDetail,
  runOpenCodeSdk,
  parseOpenCodeModelSlug,
  openCodeQuestionId,
  toOpenCodeFileParts,
  buildOpenCodePermissionRules,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeRuntimeShape,
  type OpenCodeServerProcess,
  type OpenCodeServerConnection,
  type OpenCodeCommandResult,
  type OpenCodeInventory,
  type ParsedOpenCodeModelSlug,
} from "./runtime";

export {
  OpenCodeServerPool,
  OpenCodeServerPoolLive,
  type OpenCodeServerPoolShape,
  type OpenCodeServerPoolEntrySummary,
  type OpenCodeServerPoolAcquireResult,
  type CrashCallback,
} from "./server-pool";

export {
  WarmSessionPool,
  WarmSessionPoolLive,
  type WarmSessionPoolShape,
  type WarmSessionAcquireInput,
  type WarmSessionAcquireResult,
  type WarmOpenCodeSession,
} from "./warm-session-pool";

export { OpenCodeProvider, OpenCodeProviderLive, type OpenCodeProviderShape } from "./provider";
