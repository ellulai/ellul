import { Link } from "@/i18n/routing";

export interface ConceptProps {
  slug: string;
  children?: React.ReactNode;
}

export function Concept({ slug, children }: ConceptProps) {
  const label = slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return (
    <Link
      href={`/concepts/${slug}`}
      className="text-cream underline decoration-sodium/50 underline-offset-4 transition hover:decoration-sodium"
      data-concept={slug}
    >
      {children ?? label}
    </Link>
  );
}
