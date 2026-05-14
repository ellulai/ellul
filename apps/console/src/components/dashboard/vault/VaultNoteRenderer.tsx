// SPDX-License-Identifier: MIT
"use client";

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslations } from "next-intl";

interface VaultNoteRendererProps {
  content: string;
  serverDomain: string;
  project: string;
  onNoteClick?: (noteId: string) => void;
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#(\^?)([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

// Renders Obsidian-flavored markdown with wiki-link support,
export function VaultNoteRenderer({
  content,
  serverDomain,
  project,
  onNoteClick,
}: VaultNoteRendererProps) {
  const t = useTranslations("console.vault.renderer");
  const processed = useMemo(() => {
    return content.replace(WIKILINK_RE, (_match, target, isBlock, fragment, alias) => {
      const display = alias || target;
      const href = fragment
        ? `vault://${target}#${isBlock ? "^" : ""}${fragment}`
        : `vault://${target}`;
      return `[${display}](${href})`;
    });
  }, [content]);

  const body = useMemo(() => {
    const fmMatch = processed.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    return fmMatch ? processed.slice(fmMatch[0].length) : processed;
  }, [processed]);

  const frontmatter = useMemo(() => {
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return null;
    const lines = fmMatch[1]!.split("\n");
    const entries: Array<[string, string]> = [];
    for (const line of lines) {
      const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)/);
      if (m) entries.push([m[1]!, m[2]!.trim()]);
    }
    return entries.length > 0 ? entries : null;
  }, [content]);

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      {/* Frontmatter properties */}
      {frontmatter && (
        <details className="mb-6 rounded-xl border border-cream/[0.06] bg-cream/[0.02] overflow-hidden">
          <summary className="px-4 py-2.5 cursor-pointer text-[11px] font-medium text-cream/60 uppercase tracking-wider hover:bg-cream/[0.02] select-none">
            {t("properties")}
          </summary>
          <div className="px-4 py-3 border-t border-cream/[0.04] space-y-1.5">
            {frontmatter.map(([key, value]) => (
              <div key={key} className="flex gap-3">
                <span className="text-[10px] text-cream/45 font-medium min-w-[80px] shrink-0">{key}</span>
                <span className="text-[10px] text-cream/75">{value}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Markdown content */}
      <div className="vault-prose">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children, node: _node, ...anchorProps }) => {
              if (href?.startsWith("vault://")) {
                const target = href.slice(8);
                return (
                  <button
                    onClick={() => {
                      const hashIdx = target.indexOf("#");
                      const noteName = hashIdx !== -1 ? target.slice(0, hashIdx) : target;
                      onNoteClick?.(noteName);
                    }}
                    className="text-sodium hover:text-sodium underline decoration-sodium/30 hover:decoration-sodium/60 transition-colors cursor-pointer"
                  >
                    {children}
                  </button>
                );
              }
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sodium hover:text-sodium transition-colors"
                  {...anchorProps}
                >
                  {children}
                </a>
              );
            },

            blockquote: ({ children, ...props }) => {
              const firstChild = Array.isArray(children)
                ? children.find((c: any) => c?.props?.children)
                : null;
              const text =
                typeof firstChild?.props?.children === "string"
                  ? firstChild.props.children
                  : typeof firstChild?.props?.children?.[0] === "string"
                    ? firstChild.props.children[0]
                    : "";

              const calloutMatch = text?.match?.(/^\[!(\w+)\]([+-])?\s*(.*)/);
              if (calloutMatch) {
                const type = calloutMatch[1]!.toLowerCase();
                const title = calloutMatch[3] || type.charAt(0).toUpperCase() + type.slice(1);

                const styles: Record<string, string> = {
                  note: "border-blue-400/30 bg-blue-400/5",
                  info: "border-blue-400/30 bg-blue-400/5",
                  tip: "border-green-400/30 bg-green-400/5",
                  warning: "border-sodium/30 bg-sodium/5",
                  danger: "border-terra/30 bg-terra/5",
                  bug: "border-terra/30 bg-terra/5",
                  example: "border-sodium/30 bg-sodium/5",
                  quote: "border-cream/[0.08]/30 bg-cream/[0.03]",
                  success: "border-green-400/30 bg-green-400/5",
                  question: "border-sodium/30 bg-sodium/5",
                  abstract: "border-cyan-400/30 bg-cyan-400/5",
                  todo: "border-blue-400/30 bg-blue-400/5",
                  failure: "border-terra/30 bg-terra/5",
                };

                return (
                  <div className={`border-l-2 rounded-r-lg px-4 py-3 my-4 ${styles[type] || styles.note}`}>
                    <div className="text-xs font-medium text-cream/85 mb-1">{title}</div>
                    <div className="text-xs text-cream/60 [&>p:first-child]:hidden">{children}</div>
                  </div>
                );
              }

              return (
                <blockquote className="border-l-2 border-cream/[0.1] pl-4 italic text-cream/60 my-4" {...props}>
                  {children}
                </blockquote>
              );
            },

            code: ({ className, children, ...props }) => {
              const match = className?.match(/language-(\w+)/);
              const language = match?.[1];
              const isInline = !className;

              if (isInline) {
                return (
                  <code className="px-1.5 py-0.5 rounded bg-cream/[0.06] text-sodium text-[13px] font-mono" {...props}>
                    {children}
                  </code>
                );
              }

              return (
                <div className="relative group my-4">
                  {language && (
                    <div className="absolute top-2.5 right-3 text-[9px] text-cream/35 font-mono uppercase">
                      {language}
                    </div>
                  )}
                  <pre className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4 overflow-x-auto">
                    <code className={`text-[13px] font-mono text-cream/75 ${className || ""}`} {...props}>
                      {children}
                    </code>
                  </pre>
                </div>
              );
            },

            h1: ({ children, ...props }) => (
              <h1 id={slugify(String(children))} className="text-xl font-semibold text-cream mt-8 mb-4 scroll-mt-16" {...props}>{children}</h1>
            ),
            h2: ({ children, ...props }) => (
              <h2 id={slugify(String(children))} className="text-lg font-semibold text-cream mt-7 mb-3 scroll-mt-16" {...props}>{children}</h2>
            ),
            h3: ({ children, ...props }) => (
              <h3 id={slugify(String(children))} className="text-base font-medium text-cream mt-6 mb-2.5 scroll-mt-16" {...props}>{children}</h3>
            ),
            h4: ({ children, ...props }) => (
              <h4 id={slugify(String(children))} className="text-sm font-medium text-cream mt-5 mb-2 scroll-mt-16" {...props}>{children}</h4>
            ),
            h5: ({ children, ...props }) => (
              <h5 id={slugify(String(children))} className="text-xs font-medium text-cream/85 mt-4 mb-2 scroll-mt-16" {...props}>{children}</h5>
            ),
            h6: ({ children, ...props }) => (
              <h6 id={slugify(String(children))} className="text-xs font-medium text-cream/75 mt-4 mb-2 scroll-mt-16" {...props}>{children}</h6>
            ),

            p: ({ children, ...props }) => (
              <p className="text-sm text-cream/75 leading-relaxed my-3" {...props}>{children}</p>
            ),

            ul: ({ children, ...props }) => (
              <ul className="list-disc list-inside text-sm text-cream/75 space-y-1 my-3 ml-2" {...props}>{children}</ul>
            ),
            ol: ({ children, ...props }) => (
              <ol className="list-decimal list-inside text-sm text-cream/75 space-y-1 my-3 ml-2" {...props}>{children}</ol>
            ),

            hr: () => <hr className="border-cream/[0.06] my-6" />,

            table: ({ children, ...props }) => (
              <div className="overflow-x-auto my-4 rounded-xl border border-cream/[0.06]">
                <table className="min-w-full" {...props}>{children}</table>
              </div>
            ),
            th: ({ children, ...props }) => (
              <th className="border-b border-cream/[0.06] px-3 py-2 bg-cream/[0.02] text-left text-[11px] font-medium text-cream/60 uppercase tracking-wider" {...props}>
                {children}
              </th>
            ),
            td: ({ children, ...props }) => (
              <td className="border-b border-cream/[0.04] px-3 py-2 text-xs text-cream/75" {...props}>
                {children}
              </td>
            ),

            strong: ({ children, ...props }) => (
              <strong className="font-semibold text-cream" {...props}>{children}</strong>
            ),
            em: ({ children, ...props }) => (
              <em className="italic text-cream/85" {...props}>{children}</em>
            ),

            img: ({ src, alt, ...props }) => (
              <div className="my-4 rounded-xl border border-cream/[0.06] overflow-hidden bg-cream/[0.01]">
                <img src={src} alt={alt || ""} className="max-w-full h-auto" {...props} />
                {alt && <div className="px-3 py-1.5 text-[10px] text-cream/45 border-t border-cream/[0.04]">{alt}</div>}
              </div>
            ),
          }}
        >
          {body}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}
