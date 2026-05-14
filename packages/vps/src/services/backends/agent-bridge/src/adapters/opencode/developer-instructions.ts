// SPDX-License-Identifier: BUSL-1.1
//
// System instructions injected into OpenCode turns via the `system` parameter
// of session.promptAsync. Imports platform-wide tool instructions from
// shared/platform-instructions.ts.
//
// Functions (not consts) so gbrain instructions are resolved per-turn.

import { buildSystemInstructions } from "../../shared/platform-instructions";

export function OPENCODE_PLAN_MODE_SYSTEM(): string { return buildSystemInstructions("plan"); }

export function OPENCODE_DEFAULT_MODE_SYSTEM(): string { return buildSystemInstructions("default"); }
