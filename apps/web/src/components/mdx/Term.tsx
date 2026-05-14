import { Link } from "@/i18n/routing";

export interface TermProps {
  slug: string;
  children?: React.ReactNode;
}

// Inline glossary cross-link: <Term slug="mcp">MCP</Term>. The rendered
// anchor points at /glossary/{slug} so the internal-link graph reinforces
// the glossary page for the term's canonical URL.
export function Term({ slug, children }: TermProps) {
  return (
    <Link
      href={`/glossary/${slug}`}
      className="text-cream underline decoration-sodium/40 decoration-dotted underline-offset-4 transition hover:decoration-sodium"
      data-glossary-term={slug}
    >
      {children ?? slug}
    </Link>
  );
}
