// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Preview Types — re-export from @ellul.ai/types. That workspace package
 * is the single source of truth shared between VPS code (this package)
 * and the browser console (apps/console). Do NOT add new types here —
 * add them in packages/types/src/preview.ts.
 */

export type {
  OrphanReason,
  PreviewPhase,
  ProbeHealthState,
  PreviewHealthResult,
  PreviewProbeResult,
  PreviewLifecyclePhase,
  PreviewLifecycleEvent,
} from "@ellul.ai/types";

export { CANONICAL_PREVIEW_PHASES } from "@ellul.ai/types";
