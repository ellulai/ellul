import { Link } from "@/i18n/routing";

export interface SolutionProps {
  slug: string;
  children?: React.ReactNode;
}

export function Solution({ slug, children }: SolutionProps) {
  const label = slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return (
    <Link
      href={`/solutions/${slug}`}
      className="text-cream underline decoration-sodium/50 underline-offset-4 transition hover:decoration-sodium"
      data-solution={slug}
    >
      {children ?? label}
    </Link>
  );
}
