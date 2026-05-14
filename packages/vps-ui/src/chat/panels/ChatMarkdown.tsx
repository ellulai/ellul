// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/ChatMarkdown.tsx
//
// Minimal port: react-markdown + remark-gfm + copy button on code fences.
// Upstream's shiki-backed syntax highlighting (via @pierre/diffs) and
// in-message file-link detection (editorPreferences + localApi + VSCode
// icon manifest) are deferred — they'd each pull a private dep or a
// product-layer surface the chat port doesn't currently need.

import { CheckIcon, CopyIcon } from "lucide-react";
import {
  Children,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslations } from "use-intl";

import { cn } from "../../shared/utils";

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) return null;
  const onlyChild = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) ||
    onlyChild.type !== "code"
  ) {
    return null;
  }
  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function MarkdownCodeBlock({ code, children }: { code: string; children: ReactNode }) {
  const tChat = useTranslations("chat");
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) return;
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) clearTimeout(copiedTimerRef.current);
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [code]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div className="chat-markdown-codeblock relative leading-snug">
      <button
        type="button"
        className="absolute right-2 top-2 rounded bg-popover/80 p-1 text-ink/60 opacity-0 transition hover:text-ink group-hover:opacity-100"
        onClick={handleCopy}
        title={copied ? tChat("markdown.copied") : tChat("markdown.copyCode")}
        aria-label={copied ? tChat("markdown.copied") : tChat("markdown.copyCode")}
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </button>
      {children}
    </div>
  );
}

const COMPONENTS: Components = {
  pre({ children, className, ...rest }) {
    const block = extractCodeBlock(children);
    if (!block) {
      return (
        <pre className={cn("chat-markdown-pre", className)} {...rest}>
          {children}
        </pre>
      );
    }
    return (
      <MarkdownCodeBlock code={block.code}>
        <pre
          className={cn(
            "chat-markdown-pre group overflow-x-auto rounded bg-popover px-3 py-2 text-[13px]",
            className,
          )}
          {...rest}
        >
          {children}
        </pre>
      </MarkdownCodeBlock>
    );
  },
  a({ children, href, ...rest }) {
    return (
      <a
        href={href}
        target={href?.startsWith("http") ? "_blank" : undefined}
        rel={href?.startsWith("http") ? "noreferrer" : undefined}
        className="text-sodium underline-offset-2 hover:underline"
        {...rest}
      >
        {children}
      </a>
    );
  },
};

function ChatMarkdownInner({ text }: ChatMarkdownProps) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown components={COMPONENTS} remarkPlugins={[remarkGfm]}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const ChatMarkdown = memo(ChatMarkdownInner);
