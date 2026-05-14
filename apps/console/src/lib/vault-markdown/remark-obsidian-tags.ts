// SPDX-License-Identifier: MIT

import type { Root, Text, PhrasingContent } from "mdast";
import type { Plugin } from "unified";
import { visit, SKIP } from "unist-util-visit";

// Must be preceded by whitespace or start of string.
// Must not be inside code, links, or headings (handled by skipping those node types).
const TAG_RE = /(?:^|(?<=\s))#([a-zA-Z_][\w/-]*)/g;

// Node types to skip — tags inside these should not be transformed
const SKIP_ANCESTORS = new Set(["link", "linkReference", "inlineCode", "code", "heading"]);

// Remark plugin that transforms Obsidian-style #tags into span elements
const remarkObsidianTags: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;

      // Skip tags inside code, links, and headings
      if (SKIP_ANCESTORS.has(parent.type)) return;

      const matches: Array<{ start: number; end: number; tag: string }> = [];
      let match: RegExpExecArray | null;

      TAG_RE.lastIndex = 0;
      while ((match = TAG_RE.exec(node.value)) !== null) {
        // The full match includes the # prefix; the capture group is the tag name
        const fullMatch = match[0];
        const tagName = match[1];
        if (!tagName) continue;
        const hashStart = match.index + (fullMatch.length - tagName.length - 1);
        matches.push({
          start: hashStart,
          end: hashStart + 1 + tagName.length,
          tag: tagName,
        });
      }

      if (matches.length === 0) return;

      const newNodes: PhrasingContent[] = [];
      let lastEnd = 0;

      for (const { start, end, tag } of matches) {
        if (start > lastEnd) {
          newNodes.push({ type: "text", value: node.value.slice(lastEnd, start) });
        }

        newNodes.push({
          type: "html",
          value: `<span class="vault-tag" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>`,
        } as PhrasingContent);

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

export default remarkObsidianTags;
