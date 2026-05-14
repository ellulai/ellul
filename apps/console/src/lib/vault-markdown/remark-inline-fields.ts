// SPDX-License-Identifier: MIT

import type { Root, Text, PhrasingContent } from "mdast";
import type { Plugin } from "unified";
import { visit, SKIP } from "unist-util-visit";

// Regex for Dataview-style inline fields.
const FIELD_RE = /(?:^|(?<=\s))\(?([\w][\w -]*)::\s*([^)\n]+?)\)?(?=\s|$)/g;

// Detect the parenthetical variant
const PAREN_FIELD_RE = /\(([\w][\w -]*)::\s*([^)\n]+?)\)/g;

// Remark plugin that transforms Dataview-style `key:: value` inline fields
const remarkInlineFields: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;

      // Skip inside code nodes
      if ((parent.type as string) === "code" || (parent.type as string) === "inlineCode") return;

      // First, collect parenthetical fields (hidden)
      const hiddenRanges = new Set<string>();
      let pm: RegExpExecArray | null;
      PAREN_FIELD_RE.lastIndex = 0;
      while ((pm = PAREN_FIELD_RE.exec(node.value)) !== null) {
        hiddenRanges.add(`${pm.index}:${pm.index + pm[0].length}`);
      }

      // Now match all fields
      const matches: Array<{ start: number; end: number; key: string; value: string; hidden: boolean }> = [];
      let match: RegExpExecArray | null;

      FIELD_RE.lastIndex = 0;
      while ((match = FIELD_RE.exec(node.value)) !== null) {
        const full = match[0];
        const key = match[1];
        const value = match[2];
        if (!key || !value) continue;
        const hidden = full.startsWith("(") && full.endsWith(")");
        matches.push({
          start: match.index,
          end: match.index + full.length,
          key: key.trim(),
          value: value.trim(),
          hidden,
        });
      }

      if (matches.length === 0) return;

      const newNodes: PhrasingContent[] = [];
      let lastEnd = 0;

      for (const { start, end, key, value, hidden } of matches) {
        if (start > lastEnd) {
          newNodes.push({ type: "text", value: node.value.slice(lastEnd, start) });
        }

        const hiddenAttr = hidden ? ` data-field-hidden="true"` : "";
        const html =
          `<span class="inline-field"${hiddenAttr}>` +
          `<span class="inline-field-key" data-field-key="${escapeHtml(key)}">${escapeHtml(key)}</span>` +
          `<span class="inline-field-sep">::</span> ` +
          `<span class="inline-field-value">${escapeHtml(value)}</span>` +
          `</span>`;

        newNodes.push({ type: "html", value: html } as PhrasingContent);
        lastEnd = end;
      }

      if (lastEnd < node.value.length) {
        newNodes.push({ type: "text", value: node.value.slice(lastEnd) });
      }

      parent.children.splice(index, 1, ...(newNodes as typeof parent.children[number][]));
      return [SKIP, index + newNodes.length] as const;
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

export default remarkInlineFields;
