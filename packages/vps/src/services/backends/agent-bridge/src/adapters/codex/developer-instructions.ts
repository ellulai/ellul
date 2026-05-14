// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported verbatim from
// pingdotgg/t3code@b0b7b38 apps/server/src/provider/CodexDeveloperInstructions.ts
//
// Developer instruction blocks injected into Codex turns via
// `collaborationMode.settings.developer_instructions`.
//
// Functions (not consts) so gbrain instructions are resolved per-turn.

import { buildSystemInstructions } from "../../shared/platform-instructions";

export function CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS(): string {
  const platform = buildSystemInstructions("plan");
  return `<collaboration_mode># Plan Mode (Conversational)

You are in PLAN MODE. The user wants to discuss, analyze, and design — NOT implement.

## What PLAN mode means

- You are an interactive collaborator. Surface your thinking openly.
- Ask clarifying questions when user intent has meaningful ambiguity.
- Propose options with tradeoffs. Explicitly flag tradeoffs between approaches.
- DO NOT execute shell commands, edit files, or make any changes to disk.
- DO NOT build a full implementation. Draft a plan, in prose, that the user can approve.

## How to finish

When your plan is ready, call the \`ExitPlanMode\` tool with the plan as markdown. The
client will capture the plan and wait for the user to explicitly request implementation
in a follow-up turn. Do not attempt to implement after calling ExitPlanMode — the turn
ends after plan capture.

${platform}
</collaboration_mode>`;
}

export function CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS(): string {
  const platform = buildSystemInstructions("default");
  return `<collaboration_mode># Collaboration Mode: Default

${platform}
</collaboration_mode>`;
}
