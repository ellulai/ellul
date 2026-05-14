// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { ClaudeAgentEffort, ClaudeModelSelection } from "@ellul.ai/types";
import type { ClaudeAgentSettings } from "../../../shared/serverSettings";
import { applyClaudePromptEffortPrefix, trimOrNull } from "../../../shared/model";
import { getClaudeModelCapabilities, resolveClaudeApiModelId } from "../provider";
import { parseCliArgs } from "../../../shared/cliArgs";

export interface ClaudeArgsInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly modelSelection?: ClaudeModelSelection;
  readonly injectedPrimer?: string | null;
  readonly continueFlag: boolean;
  readonly settings: ClaudeAgentSettings;
}

export interface BuiltClaudeArgs {
  readonly argv: ReadonlyArray<string>;
  readonly apiModelId: string | undefined;
}

/**
 * Prepend a prompt-injected effort marker (e.g. `Ultrathink:\n…`) to the
 * user's input when the selected model uses prompt-injected effort levels.
 * Returns the original text otherwise.
 */
export function applyEffortPrefix(
  text: string,
  modelSelection: ClaudeModelSelection | undefined,
): string {
  const claudeModel = modelSelection?.provider === "claudeAgent" ? modelSelection : undefined;
  if (!claudeModel) return text;
  const caps = getClaudeModelCapabilities(claudeModel.model);
  const trimmed = trimOrNull(claudeModel.options?.effort);
  const effort: ClaudeAgentEffort | null =
    trimmed && caps.promptInjectedEffortLevels.includes(trimmed)
      ? (trimmed as ClaudeAgentEffort)
      : null;
  return applyClaudePromptEffortPrefix(text, effort);
}

export function buildClaudeArgs(input: ClaudeArgsInput): BuiltClaudeArgs {
  const claudeModelSelection =
    input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
  const apiModelId = claudeModelSelection ? resolveClaudeApiModelId(claudeModelSelection) : undefined;

  const launchExtras = parseCliArgs(input.settings.launchArgs).flags;
  const launchExtraArgs: string[] = [];
  for (const [flag, value] of Object.entries(launchExtras)) {
    launchExtraArgs.push(flag.startsWith("--") ? flag : `--${flag}`);
    if (value !== null && value !== "") launchExtraArgs.push(value);
  }

  const argv: string[] = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--include-partial-messages",
    "--session-id",
    input.sessionId,
    "--add-dir",
    input.cwd,
  ];

  if (input.continueFlag) argv.push("--continue");
  if (apiModelId) argv.push("--model", apiModelId);
  if (input.injectedPrimer && input.injectedPrimer.trim().length > 0) {
    argv.push("--append-system-prompt", input.injectedPrimer);
  }
  for (const extra of launchExtraArgs) argv.push(extra);

  return { argv, apiModelId };
}

/** Append a newline before writing to stdin. */
export function formatStreamJsonUserMessage(input: { readonly text: string }): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: input.text }],
    },
  });
}
