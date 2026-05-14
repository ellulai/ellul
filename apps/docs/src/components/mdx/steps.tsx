import type { ReactNode } from "react";

interface StepProps {
  number: number;
  title: string;
  children: ReactNode;
}

export function Step({ number, title, children }: StepProps) {
  return (
    <div className="not-prose relative pl-10 pb-8 last:pb-0">
      <div className="absolute left-0 top-0 flex h-7 w-7 items-center justify-center rounded-full bg-sodium text-xs font-bold text-ink">
        {number}
      </div>
      <div className="absolute left-[13px] top-7 bottom-0 w-px bg-[#1A1A23] last:hidden" />
      <h4 className="mb-1 text-sm font-semibold text-cream">{title}</h4>
      <div className="text-sm text-cream/75 [&>p]:my-1">{children}</div>
    </div>
  );
}

interface StepsProps {
  children: ReactNode;
}

export function Steps({ children }: StepsProps) {
  return <div className="not-prose my-8">{children}</div>;
}
