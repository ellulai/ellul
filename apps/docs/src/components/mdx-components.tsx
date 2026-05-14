import type { ComponentPropsWithoutRef } from "react";

export const mdxComponents = {
  h1: (props: ComponentPropsWithoutRef<"h1">) => (
    <h1
      className="mb-4 mt-8 text-3xl font-semibold tracking-tight text-cream"
      {...props}
    />
  ),
  h2: (props: ComponentPropsWithoutRef<"h2">) => (
    <h2
      className="mb-3 mt-10 border-b border-[rgba(245, 239, 230, 0.07)] pb-2 text-2xl font-semibold tracking-tight text-cream"
      {...props}
    />
  ),
  h3: (props: ComponentPropsWithoutRef<"h3">) => (
    <h3
      className="mb-2 mt-8 text-xl font-semibold tracking-tight text-cream"
      {...props}
    />
  ),
  h4: (props: ComponentPropsWithoutRef<"h4">) => (
    <h4 className="mb-2 mt-6 text-lg font-semibold text-cream" {...props} />
  ),
  p: (props: ComponentPropsWithoutRef<"p">) => (
    <p className="my-4 leading-7 text-cream/85" {...props} />
  ),
  a: (props: ComponentPropsWithoutRef<"a">) => (
    <a
      className="font-medium text-sodium underline decoration-sodium/30 underline-offset-4 transition-colors hover:text-sodium hover:decoration-sodium/50"
      {...props}
    />
  ),
  ul: (props: ComponentPropsWithoutRef<"ul">) => (
    <ul className="my-4 list-disc pl-6 text-cream/85 marker:text-cream/65" {...props} />
  ),
  ol: (props: ComponentPropsWithoutRef<"ol">) => (
    <ol className="my-4 list-decimal pl-6 text-cream/85 marker:text-cream/65" {...props} />
  ),
  li: (props: ComponentPropsWithoutRef<"li">) => (
    <li className="my-1 leading-7" {...props} />
  ),
  blockquote: (props: ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote
      className="my-6 border-l-4 border-sodium pl-4 text-cream/75 italic"
      {...props}
    />
  ),
  hr: (props: ComponentPropsWithoutRef<"hr">) => (
    <hr className="my-8 border-[rgba(245, 239, 230, 0.07)]" {...props} />
  ),
  table: (props: ComponentPropsWithoutRef<"table">) => (
    <div className="not-prose my-6 overflow-x-auto rounded-xl border border-[rgba(245, 239, 230, 0.07)]">
      <table className="w-full text-sm" {...props} />
    </div>
  ),
  thead: (props: ComponentPropsWithoutRef<"thead">) => (
    <thead className="border-b-2 border-[rgba(245, 239, 230, 0.07)] bg-[#0B0B0F]" {...props} />
  ),
  th: (props: ComponentPropsWithoutRef<"th">) => (
    <th
      className="px-5 py-3 text-left text-sm font-medium text-cream whitespace-nowrap"
      {...props}
    />
  ),
  td: (props: ComponentPropsWithoutRef<"td">) => (
    <td className="px-5 py-3 text-cream/85" {...props} />
  ),
  tr: (props: ComponentPropsWithoutRef<"tr">) => (
    <tr className="border-b border-[rgba(245, 239, 230, 0.07)] last:border-0" {...props} />
  ),
  code: (props: ComponentPropsWithoutRef<"code">) => (
    <code
      className="rounded border border-[rgba(245, 239, 230, 0.07)] bg-[#0B0B0F] px-1.5 py-0.5 font-mono text-sm text-sodium"
      {...props}
    />
  ),
  pre: (props: ComponentPropsWithoutRef<"pre">) => (
    <pre
      className="group relative my-6 overflow-x-auto rounded-xl border border-[rgba(245, 239, 230, 0.07)] bg-[#0B0B0F] p-4 font-mono text-sm transition-shadow hover:shadow-panel-lift"
      {...props}
    />
  ),
  strong: (props: ComponentPropsWithoutRef<"strong">) => (
    <strong className="font-semibold text-cream" {...props} />
  ),
  em: (props: ComponentPropsWithoutRef<"em">) => (
    <em className="text-cream/75" {...props} />
  ),
};
