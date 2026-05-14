// SPDX-License-Identifier: MIT

import type { Root, Text, PhrasingContent, Link } from "mdast";
import type { Plugin } from "unified";
import { visit, SKIP } from "unist-util-visit";

export interface WikilinkOptions {
  // Resolve a wikilink target (note name) to a URL.
  resolveUrl?: (target: string) => string;
}

// Regex to match wikilink patterns inside text:
const WIKILINK_RE = /\[\[([^\]|#]+?)(?:#(\^?[^\]|]+?))?(?:\|([^\]]+?))?\]\]/g;

interface ParsedWikilink {
  // Full matched string
  full: string;
  // Note name / target path
  target: string;
  // Fragment: heading or ^block-id (without leading #)
  fragment: string | null;
  // Whether the fragment is a block reference (starts with ^)
  isBlockRef: boolean;
  // Display text override from the | alias
  alias: string | null;
}

function parseWikilinks(text: string): Array<{ start: number; end: number; link: ParsedWikilink }> {
  const results: Array<{ start: number; end: number; link: ParsedWikilink }> = [];
  let match: RegExpExecArray | null;

  WIKILINK_RE.lastIndex = 0;
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    const full = match[0];
    const target = match[1] ?? "";
    const fragment = match[2];
    const alias = match[3];
    results.push({
      start: match.index,
      end: match.index + full.length,
      link: {
        full,
        target: target.trim(),
        fragment: fragment?.trim() ?? null,
        isBlockRef: fragment?.startsWith("^") ?? false,
        alias: alias?.trim() ?? null,
      },
    });
  }

  return results;
}

function buildUrl(link: ParsedWikilink, resolveUrl: (target: string) => string): string {
  let url = resolveUrl(link.target);
  if (link.fragment) {
    const frag = link.isBlockRef ? `^${link.fragment.slice(1)}` : link.fragment;
    url += `#${encodeURIComponent(frag)}`;
  }
  return url;
}

function buildDisplayText(link: ParsedWikilink): string {
  if (link.alias) return link.alias;
  let display = link.target;
  if (link.fragment) {
    display += link.isBlockRef
      ? ` > ${link.fragment.slice(1)}`
      : ` > ${link.fragment}`;
  }
  return display;
}

// Remark plugin that transforms Obsidian-style [[wikilinks]] into standard
const remarkObsidianWikilink: Plugin<[WikilinkOptions?], Root> = (options) => {
  const resolveUrl = options?.resolveUrl ?? ((target) => `/vault/${encodeURIComponent(target)}`);

  return (tree) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === undefined) return;

      const matches = parseWikilinks(node.value);
      if (matches.length === 0) return;

      const newNodes: PhrasingContent[] = [];
      let lastEnd = 0;

      for (const { start, end, link } of matches) {
        // Text before this match
        if (start > lastEnd) {
          newNodes.push({ type: "text", value: node.value.slice(lastEnd, start) });
        }

        const url = buildUrl(link, resolveUrl);
        const displayText = buildDisplayText(link);

        const linkNode: Link = {
          type: "link",
          url,
          title: null,
          children: [{ type: "text", value: displayText }],
          data: {
            hProperties: {
              "data-wikilink": link.target,
              ...(link.fragment ? { "data-wikilink-fragment": link.fragment } : {}),
              ...(link.isBlockRef ? { "data-wikilink-block-ref": "true" } : {}),
            },
          },
        };

        newNodes.push(linkNode);
        lastEnd = end;
      }

      // Remaining text after last match
      if (lastEnd < node.value.length) {
        newNodes.push({ type: "text", value: node.value.slice(lastEnd) });
      }

      // Splice the new nodes into the parent's children
      parent.children.splice(index, 1, ...(newNodes as typeof parent.children[number][]));

      // Return the index past the inserted nodes so visit doesn't re-traverse them
      return [SKIP, index + newNodes.length] as const;
    });
  };
};

export default remarkObsidianWikilink;
