export interface FAQItem {
  id?: string;
  q: string;
  a: string;
}

export interface FAQProps {
  items?: FAQItem[];
}

/**
 * Self-contained accordion FAQ with FAQPage microdata. Mirrors the visual
 * shape of apps/web/src/app/[locale]/components/faq-list.tsx so MDX-rendered
 * FAQs and inline FaqList instances look identical, but with no app-specific
 * imports — safe to use from any surface.
 */
export function FAQ({ items = [] }: FAQProps) {
  if (!items.length) return null;
  return (
    <section
      className="!mt-6 space-y-4"
      aria-label="Frequently asked questions"
      itemScope
      itemType="https://schema.org/FAQPage"
    >
      {items.map((item) => (
        <details
          key={item.id ?? item.q}
          className="group rounded-2xl border border-cream/[0.06] bg-cream/[0.02] backdrop-blur-sm transition-all hover:border-cream/[0.1]"
          itemScope
          itemProp="mainEntity"
          itemType="https://schema.org/Question"
        >
          <summary className="flex cursor-pointer select-none items-center justify-between px-6 py-4 text-sm font-semibold text-cream">
            <span className="pr-4" itemProp="name">
              {item.q}
            </span>
            <svg
              className="h-4 w-4 shrink-0 text-cream/30 transition-transform group-open:rotate-45"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4.5v15m7.5-7.5h-15"
              />
            </svg>
          </summary>
          <div
            itemScope
            itemProp="acceptedAnswer"
            itemType="https://schema.org/Answer"
          >
            <p
              className="px-6 pb-5 text-sm leading-[1.7] text-cream/70"
              itemProp="text"
            >
              {item.a}
            </p>
          </div>
        </details>
      ))}
    </section>
  );
}
