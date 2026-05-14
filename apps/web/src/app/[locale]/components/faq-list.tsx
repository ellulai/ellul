type FaqItem = { q: string; a: string };

export function FaqList({ items, dense = false }: { items: FaqItem[]; dense?: boolean }) {
  return (
    <div className={dense ? "space-y-3" : "space-y-4"}>
      {items.map((item) => (
        <details
          key={item.q}
          className="group rounded-2xl border border-cream/[0.06] bg-cream/[0.02] backdrop-blur-sm transition-all hover:border-cream/[0.1]"
        >
          <summary className="flex cursor-pointer select-none items-center justify-between px-6 py-4 text-sm font-semibold text-cream">
            <span className="pr-4">{item.q}</span>
            <svg
              className="h-4 w-4 shrink-0 text-cream/30 transition-transform group-open:rotate-45"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </summary>
          <p className="px-6 pb-5 text-sm leading-[1.7] text-cream/70">{item.a}</p>
        </details>
      ))}
    </div>
  );
}

export function faqSchemaFor(items: FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.a,
      },
    })),
  };
}

export type { FaqItem };
