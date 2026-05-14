import type { MDXComponents } from "mdx/types";
import type { ReactNode } from "react";
import { Link } from "@/i18n/routing";
import { FaqList, type FaqItem } from "@/app/[locale]/components/faq-list";
import { slugify } from "@/lib/extract-headings";
import { Comparison } from "@/components/mdx/Comparison";
import { Solution } from "@/components/mdx/Solution";
import { Concept } from "@/components/mdx/Concept";
import { Agent } from "@/components/mdx/Agent";

export interface CalloutProps {
  variant?: "info" | "warn" | "success";
  title?: string;
  children: ReactNode;
}

export function Callout({ variant = "info", title, children }: CalloutProps) {
  const tone =
    variant === "warn"
      ? "border-amber-400/30 bg-amber-500/5 text-amber-100"
      : variant === "success"
        ? "border-emerald-400/30 bg-emerald-500/5 text-emerald-100"
        : "border-sodium/30 bg-sodium-soft text-cream/85";

  return (
    <aside className={`my-8 rounded-2xl border p-5 sm:p-6 ${tone}`}>
      {title && (
        <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-sodium">
          {title}
        </p>
      )}
      <div className="mt-2 text-[15px] leading-[1.75]">{children}</div>
    </aside>
  );
}

export interface CodeTabsProps {
  children: ReactNode;
}

export function CodeTabs({ children }: CodeTabsProps) {
  return (
    <div className="my-8 overflow-hidden rounded-2xl border border-cream/[0.08] bg-black/40">
      {children}
    </div>
  );
}

export interface ImageProps {
  src: string;
  alt: string;
  caption?: string;
}

export function Image({ src, alt, caption }: ImageProps) {
  return (
    <figure className="my-8">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="rounded-2xl border border-cream/[0.06]"
      />
      {caption && (
        <figcaption className="mt-2 text-center text-xs text-cream/45">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

export interface NumberedItemProps {
  heading: string;
  children: ReactNode;
}

export function NumberedList({ children }: { children: ReactNode }) {
  return (
    <ol className="my-6 space-y-3 pl-6 [counter-reset:item]">{children}</ol>
  );
}

export function NumberedItem({ heading, children }: NumberedItemProps) {
  return (
    <li
      className="relative pl-6 before:absolute before:left-0 before:top-0 before:font-mono before:text-sodium before:content-[counter(item)_'.']"
      style={{ counterIncrement: "item" }}
    >
      <strong className="font-medium text-cream">{heading}.</strong>{" "}
      <span className="text-cream/80">{children}</span>
    </li>
  );
}

export function BulletList({ children }: { children: ReactNode }) {
  return <ul className="my-6 space-y-3 pl-6">{children}</ul>;
}

export function BulletItem({ heading, children }: NumberedItemProps) {
  return (
    <li className="relative pl-4 before:absolute before:left-0 before:top-[0.65em] before:h-1 before:w-1 before:rounded-full before:bg-sodium">
      <strong className="font-medium text-cream">{heading}.</strong>{" "}
      <span className="text-cream/80">{children}</span>
    </li>
  );
}

export interface CtaProps {
  eyebrow: string;
  body: string;
  primary: { href: string; label: string };
  links?: Array<{ href: string; label: string }>;
}

export function Cta({ eyebrow, body, primary, links }: CtaProps) {
  return (
    <div className="my-12 rounded-2xl border border-sodium/30 bg-sodium-soft p-6 sm:p-8">
      <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-sodium">
        {eyebrow}
      </p>
      <p className="mt-3 text-[15px] leading-[1.75] text-cream/85 sm:text-base">
        {body}
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <a
          href={primary.href}
          className="rounded-md bg-sodium px-5 py-2.5 text-sm font-semibold text-ink transition hover:bg-sodium-strong"
        >
          {primary.label}
        </a>
        {links?.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="text-sm text-cream/70 transition hover:text-cream"
          >
            {l.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function Faq({ items }: { items: FaqItem[] }) {
  return (
    <div className="!mt-6">
      <FaqList items={items} />
    </div>
  );
}

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
export const baseProseComponents: MDXComponents = {
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
    <p className="text-[15px] leading-[1.8] text-cream/80 sm:text-base">{children}</p>
  ),
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
  hr: () => <hr className="!my-12 border-cream/[0.08]" />,
  strong: ({ children }) => (
    <strong className="font-medium text-cream">{children}</strong>
  ),
  em: ({ children }) => <em className="text-cream/85">{children}</em>,
};

export function buildBlogMdxComponents(faqItems: FaqItem[] = []): MDXComponents {
  return {
    ...baseProseComponents,
    Callout,
    CodeTabs,
    Image,
    NumberedList,
    NumberedItem,
    BulletList,
    BulletItem,
    Cta,
    Comparison,
    Solution,
    Concept,
    Agent,
    Faq: () => <Faq items={faqItems} />,
  };
}
