import type { MDXComponents } from "mdx/types";
import type { ReactNode } from "react";
import { Link } from "@/i18n/routing";
import {
  Callout,
  CodeTabs,
  CodeTab,
  Image,
  PricingTable,
  FAQ,
  type FAQItem,
} from "@ellul.ai/marketing-mdx";
import { FeatureMatrix } from "@/components/comparison/FeatureMatrix";
import { Verdict } from "@/components/comparison/Verdict";
import { Term } from "@/components/mdx/Term";
import { Comparison } from "@/components/mdx/Comparison";
import { Solution } from "@/components/mdx/Solution";
import { Concept } from "@/components/mdx/Concept";
import { Agent } from "@/components/mdx/Agent";
import { slugify } from "@/lib/extract-headings";

export {
  Callout,
  CodeTabs,
  CodeTab,
  Image,
  PricingTable,
  FAQ,
  FeatureMatrix,
  Verdict,
  Term,
  Comparison,
  Solution,
  Concept,
  Agent,
};

function getTextContent(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(getTextContent).join("");
  if (children && typeof children === "object" && "props" in children) {
    return getTextContent((children as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

/** Tailwind-styled defaults for prose elements that come straight from MDX. */
const baseProseComponents: MDXComponents = {
  h2: ({ children }) => {
    const id = slugify(getTextContent(children));
    return (
      <h2
        id={id}
        className="group !mt-12 text-2xl font-light tracking-[-0.02em] text-cream sm:text-[1.75rem]"
      >
        {children}
        <a
          href={`#${id}`}
          aria-hidden="true"
          tabIndex={-1}
          className="ml-2 text-cream/0 transition-colors group-hover:text-cream/30"
        >
          #
        </a>
      </h2>
    );
  },
  h3: ({ children }) => {
    const id = slugify(getTextContent(children));
    return (
      <h3
        id={id}
        className="group !mt-8 text-xl font-light tracking-[-0.02em] text-cream sm:text-[1.5rem]"
      >
        {children}
        <a
          href={`#${id}`}
          aria-hidden="true"
          tabIndex={-1}
          className="ml-2 text-cream/0 transition-colors group-hover:text-cream/30"
        >
          #
        </a>
      </h3>
    );
  },
  p: ({ children }) => (
    <p className="text-[15px] leading-[1.8] text-cream/80 sm:text-base">
      {children}
    </p>
  ),
  ul: ({ children }) => (
    <ul className="my-4 list-disc space-y-2 pl-6 text-cream/80">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-4 list-decimal space-y-2 pl-6 text-cream/80">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-[1.7]">{children}</li>,
  a: ({ href, children }) => {
    const isInternal = href?.startsWith("/") && !href.startsWith("//");
    if (isInternal) {
      return (
        <Link
          href={href!}
          className="text-sodium underline-offset-4 hover:underline"
        >
          {children}
        </Link>
      );
    }
    return (
      <a
        href={href}
        className="text-sodium underline-offset-4 hover:underline"
        rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
      >
        {children}
      </a>
    );
  },
  code: ({ children }) => (
    <code className="rounded bg-cream/[0.06] px-1 py-0.5 font-mono text-[13px] text-cream">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-6 overflow-x-auto rounded-2xl border border-cream/[0.08] bg-black/40 p-4 text-[13px] leading-[1.6]">
      {children}
    </pre>
  ),
  hr: () => <hr className="!my-12 border-cream/[0.08]" />,
  strong: ({ children }) => (
    <strong className="font-medium text-cream">{children}</strong>
  ),
  em: ({ children }) => <em className="text-cream/85">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="my-6 border-l-2 border-sodium/40 pl-4 text-cream/75">
      {children}
    </blockquote>
  ),
};

export interface SharedMdxOptions {
  faqItems?: FAQItem[];
}

export function buildSharedMdxComponents({
  faqItems = [],
}: SharedMdxOptions = {}): MDXComponents {
  return {
    ...baseProseComponents,
    Callout,
    CodeTabs,
    CodeTab,
    Image,
    PricingTable,
    FeatureMatrix,
    Verdict,
    Term,
    Comparison,
    Solution,
    Concept,
    Agent,
    FAQ: (props: { items?: FAQItem[] }) => (
      <FAQ items={props.items ?? faqItems} />
    ),
  };
}

export const MDX_SHORTCODES = [
  "Callout",
  "CodeTabs",
  "CodeTab",
  "Image",
  "PricingTable",
  "FeatureMatrix",
  "Verdict",
  "Term",
  "Comparison",
  "Solution",
  "Concept",
  "Agent",
  "FAQ",
] as const;

export type MdxShortcode = (typeof MDX_SHORTCODES)[number];
