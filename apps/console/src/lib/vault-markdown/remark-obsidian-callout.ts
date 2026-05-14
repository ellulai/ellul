// SPDX-License-Identifier: MIT

import type { Root, Blockquote, Paragraph, Text, RootContent } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

const CALLOUT_TYPES = new Set([
  "note", "abstract", "info", "todo", "tip", "success",
  "question", "warning", "failure", "danger", "bug", "example", "quote",
]);

// 1: callout type (e.g. "warning")
const CALLOUT_RE = /^\[!(\w+)\]([+-])?\s*(.*)?$/;

interface CalloutData {
  calloutType: string;
  title: string;
  foldable: boolean;
  defaultExpanded: boolean;
}

function parseCalloutLine(text: string): CalloutData | null {
  const match = CALLOUT_RE.exec(text.trim());
  if (!match) return null;

  const rawType = match[1];
  const foldIndicator = match[2];
  const rawTitle = match[3];
  if (!rawType) return null;
  const calloutType = rawType.toLowerCase();

  if (!CALLOUT_TYPES.has(calloutType)) return null;

  return {
    calloutType,
    title: rawTitle?.trim() || calloutType.charAt(0).toUpperCase() + calloutType.slice(1),
    foldable: foldIndicator === "+" || foldIndicator === "-",
    defaultExpanded: foldIndicator !== "-",
  };
}

// Remark plugin that transforms Obsidian-style callout blockquotes
const remarkObsidianCallout: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, "blockquote", (node: Blockquote, index, parent) => {
      if (!parent || index === undefined) return;
      if (node.children.length === 0) return;

      // First child must be a paragraph whose first child is a text node with the marker
      const firstChild = node.children[0];
      if (!firstChild || firstChild.type !== "paragraph") return;

      const para = firstChild as Paragraph;
      if (para.children.length === 0) return;

      const firstText = para.children[0];
      if (!firstText || firstText.type !== "text") return;

      const callout = parseCalloutLine((firstText as Text).value);
      if (!callout) return;

      // Build the content: everything after the callout marker line.
      const remainingInlineText = (firstText as Text).value.replace(CALLOUT_RE, "").trim();
      const contentChildren: RootContent[] = [];

      // Remaining inline content from the first paragraph (after marker)
      if (remainingInlineText || para.children.length > 1) {
        const inlineChildren = [...para.children.slice(1)];
        if (remainingInlineText) {
          inlineChildren.unshift({ type: "text", value: remainingInlineText });
        }
        if (inlineChildren.length > 0) {
          contentChildren.push({ type: "paragraph", children: inlineChildren } as Paragraph);
        }
      }

      // Rest of the blockquote children after the first paragraph
      for (let i = 1; i < node.children.length; i++) {
        contentChildren.push(node.children[i] as RootContent);
      }

      const attrs: Record<string, string> = {
        class: `callout callout-${callout.calloutType}`,
        "data-callout-type": callout.calloutType,
      };
      if (callout.foldable) {
        attrs["data-callout-foldable"] = "true";
        attrs["data-callout-expanded"] = String(callout.defaultExpanded);
      }

      // Build the replacement HTML node structure.
      const titleHtml = `<div ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}><div class="callout-title">${escapeHtml(callout.title)}</div><div class="callout-content">`;
      const closingHtml = `</div></div>`;

      const replacementNodes: RootContent[] = [
        { type: "html", value: titleHtml },
        ...contentChildren,
        { type: "html", value: closingHtml },
      ];

      parent.children.splice(index, 1, ...(replacementNodes as typeof parent.children[number][]));
    });
  };
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default remarkObsidianCallout;
