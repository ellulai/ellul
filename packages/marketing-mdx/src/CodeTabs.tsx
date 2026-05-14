import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";

export interface CodeTabProps {
  label: string;
  children: ReactNode;
}

// One labeled section inside a CodeTabs group. The label renders as a small
// heading bar above the children so prerendered HTML is readable, citation
// friendly, and works without JavaScript. Stays a server component to avoid
// hauling client-bundle weight onto every MDX page that mentions a CLI.
export function CodeTab({ label, children }: CodeTabProps) {
  return (
    <section
      data-codetab-label={label}
      className="border-b border-cream/[0.06] last:border-b-0"
    >
      <header className="border-b border-cream/[0.06] bg-cream/[0.015] px-4 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-cream/65">
          {label}
        </span>
      </header>
      <div className="px-1 py-1">{children}</div>
    </section>
  );
}

function hasLabelProp(node: ReactNode): node is ReactElement<CodeTabProps> {
  if (!isValidElement(node)) return false;
  const props = node.props as { label?: unknown } | null;
  return typeof props?.label === "string";
}

export interface CodeTabsProps {
  children: ReactNode;
}

// Groups labeled code samples (typically CLI versus config file) inside a
// shared bordered container. When at least one child is a <CodeTab>, the
// group is announced as a labeled region for assistive tech. Older MDX that
// passes raw code fences directly still renders correctly because the
// container is unconditional and the label-detection only adds aria hints.
export function CodeTabs({ children }: CodeTabsProps) {
  const labeled = Children.toArray(children).some(hasLabelProp);
  return (
    <div
      role={labeled ? "group" : undefined}
      aria-label={labeled ? "Code samples" : undefined}
      className="my-8 overflow-hidden rounded-2xl border border-cream/[0.08] bg-black/40"
    >
      {children}
    </div>
  );
}
