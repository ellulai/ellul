// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Prompt builders for ellul's thread-title generation. Upstream's
// Prompts.ts relies on `--json-schema` to coerce structured output; our
// claude.ts uses the plain `--output-format json` envelope and treats the
// assistant's `.result` string as the title directly, so the prompt must
// ask for plain text without JSON wrapping.

const MESSAGE_CHAR_LIMIT = 8_000;

export function buildThreadTitlePrompt(message: string): string {
  const trimmed =
    message.length > MESSAGE_CHAR_LIMIT ? `${message.slice(0, MESSAGE_CHAR_LIMIT)}…` : message;
  return [
    "Summarize the following user message as a 3-5 word thread title.",
    "Reply with ONLY the title, no punctuation, no quotes, no prefix, no trailing period.",
    "",
    `Message: ${trimmed}`,
  ].join("\n");
}
