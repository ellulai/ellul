import { Link } from "@/i18n/routing";

export interface BreadcrumbItem {
  name: string;
  href: string;
}

export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 font-mono text-[11px] tracking-[0.18em]">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={item.href} className="flex items-center gap-1">
              {i > 0 && (
                <span aria-hidden className="text-cream/25 select-none">/</span>
              )}
              {isLast ? (
                <span className="text-cream/45">{item.name}</span>
              ) : (
                <Link
                  href={item.href}
                  className="text-cream/35 transition-colors hover:text-cream/70"
                >
                  {item.name}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
