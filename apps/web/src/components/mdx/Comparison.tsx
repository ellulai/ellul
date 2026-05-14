import { Link } from "@/i18n/routing";

export interface ComparisonProps {
  slug: string;
  children?: React.ReactNode;
}

export function Comparison({ slug, children }: ComparisonProps) {
  const label = slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return (
    <Link
      href={`/vs/${slug}`}
      className="text-cream underline decoration-sodium/50 underline-offset-4 transition hover:decoration-sodium"
      data-comparison={slug}
    >
      {children ?? `${label} comparison`}
    </Link>
  );
}
