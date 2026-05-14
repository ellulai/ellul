import type { Heading } from "@/lib/extract-headings";

interface TableOfContentsProps {
  headings: Heading[];
}

export function TableOfContents({ headings }: TableOfContentsProps) {
  if (headings.length === 0) return null;

  // Group h3s under their preceding h2
  const grouped: Array<{ h2: Heading; children: Heading[] }> = [];
  for (const heading of headings) {
    if (heading.level === 2) {
      grouped.push({ h2: heading, children: [] });
    } else if (heading.level === 3 && grouped.length > 0) {
      grouped[grouped.length - 1]!.children.push(heading);
    }
  }

  return (
    <nav aria-label="Table of contents" className="text-sm">
      <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/35">
        On this page
      </p>
      <ul className="mt-3 space-y-2">
        {grouped.map(({ h2, children }) => (
          <li key={h2.id}>
            <a
              href={`#${h2.id}`}
              className="block text-cream/55 transition-colors hover:text-cream"
            >
              {h2.text}
            </a>
            {children.length > 0 && (
              <ul className="mt-1.5 space-y-1.5 border-l border-cream/[0.08] pl-3">
                {children.map((h3) => (
                  <li key={h3.id}>
                    <a
                      href={`#${h3.id}`}
                      className="block text-[13px] text-cream/40 transition-colors hover:text-cream/70"
                    >
                      {h3.text}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
