// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

export const PROPOSED_PLAN_OPEN_TAG = "<proposed_plan>";
export const PROPOSED_PLAN_CLOSE_TAG = "</proposed_plan>";

// Extract the plan markdown between <proposed_plan>...</proposed_plan> tags. Returns null if absent.
export function extractProposedPlanMarkdown(text: string): string | null {
  const openIdx = text.indexOf(PROPOSED_PLAN_OPEN_TAG);
  if (openIdx < 0) return null;
  const closeIdx = text.indexOf(PROPOSED_PLAN_CLOSE_TAG, openIdx + PROPOSED_PLAN_OPEN_TAG.length);
  const inner = closeIdx < 0
    ? text.slice(openIdx + PROPOSED_PLAN_OPEN_TAG.length)
    : text.slice(openIdx + PROPOSED_PLAN_OPEN_TAG.length, closeIdx);
  return inner.trim().length > 0 ? inner.trim() : null;
}

// Return the text with the plan block stripped out. Preserves surrounding copy.
export function stripProposedPlanFromText(text: string): string {
  const openIdx = text.indexOf(PROPOSED_PLAN_OPEN_TAG);
  if (openIdx < 0) return text;
  const closeIdx = text.indexOf(PROPOSED_PLAN_CLOSE_TAG, openIdx + PROPOSED_PLAN_OPEN_TAG.length);
  const before = text.slice(0, openIdx);
  const after = closeIdx < 0 ? "" : text.slice(closeIdx + PROPOSED_PLAN_CLOSE_TAG.length);
  return (before + after).trim();
}

// First markdown heading line in the plan (used as the title).
export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

// Strip leading title + "Summary" heading so the card doesn't repeat the title.
export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(/\r?\n/);
  const sourceLines = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? lines.slice(1) : [...lines];
  while (sourceLines[0]?.trim().length === 0) sourceLines.shift();
  const firstHeading = sourceLines[0]?.match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (firstHeading?.[1]?.trim().toLowerCase() === "summary") {
    sourceLines.shift();
    while (sourceLines[0]?.trim().length === 0) sourceLines.shift();
  }
  return sourceLines.join("\n");
}

export function buildCollapsedProposedPlanPreviewMarkdown(planMarkdown: string, opts?: { maxLines?: number }): string {
  const maxLines = opts?.maxLines ?? 10;
  const lines = stripDisplayedPlanMarkdown(planMarkdown).trimEnd().split(/\r?\n/).map((l) => l.trimEnd());
  const preview: string[] = [];
  let visible = 0;
  let more = false;
  for (const line of lines) {
    const isVisible = line.trim().length > 0;
    if (isVisible && visible >= maxLines) { more = true; break; }
    preview.push(line);
    if (isVisible) visible += 1;
  }
  while (preview.length > 0 && preview.at(-1)?.trim().length === 0) preview.pop();
  if (preview.length === 0) return proposedPlanTitle(planMarkdown) ?? "Plan preview unavailable.";
  if (more) preview.push("", "...");
  return preview.join("\n");
}

export function proposedPlanFilename(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown) ?? "plan";
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "plan";
  return `${slug}.md`;
}

function sanitizePlanFileSegment(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "plan";
}

export function buildProposedPlanMarkdownFilename(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  return `${sanitizePlanFileSegment(title ?? "plan")}.md`;
}

export function normalizePlanMarkdownForExport(planMarkdown: string): string {
  return `${planMarkdown.trimEnd()}\n`;
}

export function downloadPlanAsTextFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `PLEASE IMPLEMENT THIS PLAN:\n${planMarkdown.trim()}`;
}

export function resolvePlanFollowUpSubmission(input: {
  draftText: string;
  planMarkdown: string;
}): {
  text: string;
  interactionMode: "default" | "plan";
} {
  const trimmedDraftText = input.draftText.trim();
  if (trimmedDraftText.length > 0) {
    return {
      text: trimmedDraftText,
      interactionMode: "plan",
    };
  }
  return {
    text: buildPlanImplementationPrompt(input.planMarkdown),
    interactionMode: "default",
  };
}

export function buildPlanImplementationThreadTitle(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  return title ? `Implement ${title}` : "Implement plan";
}
