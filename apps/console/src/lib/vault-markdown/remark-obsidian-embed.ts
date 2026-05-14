// SPDX-License-Identifier: MIT

import type { Root, Text, PhrasingContent } from "mdast";
import type { Plugin } from "unified";
import { visit, SKIP } from "unist-util-visit";

// Regex for embed syntax: ![[target]] or ![[target|param]]
const EMBED_RE = /!\[\[([^\]|#]+?)(?:#(\^?[^\]|]+?))?(?:\|([^\]]+?))?\]\]/g;

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico", ".avif",
]);

function isImageFile(target: string): boolean {
  const lower = target.toLowerCase();
  return IMAGE_EXTENSIONS.has(lower.slice(lower.lastIndexOf(".")));
}

// Remark plugin that transforms Obsidian-style ![[embeds]] into custom nodes.
const remarkObsidianEmbed: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;

      const matches: Array<{ start: number; end: number; groups: RegExpExecArray }> = [];
      let match: RegExpExecArray | null;

      EMBED_RE.lastIndex = 0;
      while ((match = EMBED_RE.exec(node.value)) !== null) {
        matches.push({ start: match.index, end: match.index + match[0].length, groups: match });
      }

      if (matches.length === 0) return;

      const newNodes: PhrasingContent[] = [];
      let lastEnd = 0;

      for (const { start, end, groups } of matches) {
        const target = groups[1] ?? "";
        const fragment = groups[2];
        const param = groups[3];
        const trimmedTarget = target.trim();

        if (start > lastEnd) {
          newNodes.push({ type: "text", value: node.value.slice(lastEnd, start) });
        }

        if (isImageFile(trimmedTarget)) {
          // Image embed
          const attrs: Record<string, string> = {
            "data-embed": "image",
            "data-embed-target": trimmedTarget,
          };
          if (param?.trim()) {
            const width = parseInt(param.trim(), 10);
            if (!isNaN(width)) attrs["data-embed-width"] = String(width);
          }
          newNodes.push({
            type: "image",
            url: trimmedTarget,
            alt: trimmedTarget,
            title: null,
            data: { hProperties: attrs },
          });
        } else {
          // Note embed — render as a placeholder div for the React layer
          const attrs: Record<string, string> = {
            "data-embed": "note",
            "data-embed-target": trimmedTarget,
          };
          if (fragment?.trim()) {
            attrs["data-embed-fragment"] = fragment.trim();
          }
          if (param?.trim()) {
            attrs["data-embed-alias"] = param.trim();
          }
          const attrStr = Object.entries(attrs)
            .map(([k, v]) => `${k}="${escapeHtml(v)}"`)
            .join(" ");

          // Use an inline html node — the React renderer should detect and hydrate it
          newNodes.push({
            type: "html",
            value: `<div class="vault-embed" ${attrStr}></div>`,
          } as PhrasingContent);
        }

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

export default remarkObsidianEmbed;
