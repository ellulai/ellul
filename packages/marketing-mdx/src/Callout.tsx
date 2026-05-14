import type { ReactNode } from "react";

export type CalloutType = "note" | "warning" | "tip";

export interface CalloutProps {
  type?: CalloutType;
  title?: string;
  children: ReactNode;
}

const TONE: Record<CalloutType, string> = {
  note: "border-sodium/30 bg-sodium-soft text-cream/85",
  warning: "border-amber-400/30 bg-amber-500/5 text-amber-100",
  tip: "border-emerald-400/30 bg-emerald-500/5 text-emerald-100",
};

const LABEL: Record<CalloutType, string> = {
  note: "Note",
  warning: "Warning",
  tip: "Tip",
};

export function Callout({ type = "note", title, children }: CalloutProps) {
  return (
    <aside
      className={`my-8 rounded-2xl border p-5 sm:p-6 ${TONE[type]}`}
      role="note"
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-sodium">
        {title ?? LABEL[type]}
      </p>
      <div className="mt-2 text-[15px] leading-[1.75]">{children}</div>
    </aside>
  );
}
