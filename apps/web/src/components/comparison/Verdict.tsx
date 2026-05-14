import type { Verdict as VerdictData } from "@/content/comparisons/schema";

export function Verdict({ headline, body }: VerdictData) {
  return (
    <blockquote className="relative my-2 rounded-2xl border border-sodium/30 bg-sodium-soft p-6 sm:p-8">
      <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-sodium">
        Verdict
      </p>
      <p className="mt-3 text-xl font-light leading-snug tracking-[-0.02em] text-cream sm:text-2xl">
        {headline}
      </p>
      <p className="mt-3 text-[15px] leading-[1.75] text-cream/80 sm:text-base">
        {body}
      </p>
    </blockquote>
  );
}
