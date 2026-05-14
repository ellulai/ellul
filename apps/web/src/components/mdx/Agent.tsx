import { Link } from "@/i18n/routing";

export interface AgentProps {
  slug: string;
  children?: React.ReactNode;
}

export function Agent({ slug, children }: AgentProps) {
  const label = slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return (
    <Link
      href={`/agents/${slug}`}
      className="text-cream underline decoration-sodium/50 underline-offset-4 transition hover:decoration-sodium"
      data-agent={slug}
    >
      {children ?? label}
    </Link>
  );
}
