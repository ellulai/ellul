import type { ReactNode } from "react";

interface FaqItemProps {
  question: string;
  children: ReactNode;
}

export function FaqItem({ question, children }: FaqItemProps) {
  return (
    <details className="not-prose group border-b border-[rgba(245, 239, 230, 0.07)]">
      <summary className="flex cursor-pointer items-center justify-between py-4 text-sm font-medium text-cream transition-colors hover:text-sodium [&::-webkit-details-marker]:hidden">
        {question}
        <span className="ml-4 shrink-0 text-cream/60 transition-transform group-open:rotate-45">
          +
        </span>
      </summary>
      <div className="pb-4 text-sm leading-relaxed text-cream/75 [&>p]:my-2">
        {children}
      </div>
    </details>
  );
}

interface FaqSectionProps {
  children: ReactNode;
}

export function FaqSection({ children }: FaqSectionProps) {
  return (
    <div className="not-prose my-8 divide-y-0 rounded-xl border border-[rgba(245, 239, 230, 0.07)] px-6">
      {children}
    </div>
  );
}
