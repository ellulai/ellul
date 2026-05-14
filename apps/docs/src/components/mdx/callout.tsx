import type { ReactNode } from "react";

const styles = {
  principle: {
    container: "border-l-4 border-sodium bg-sodium/[0.06]",
    icon: "text-sodium",
    glyph: "\u2139",
  },
  warning: {
    container: "border-l-4 border-sodium bg-sodium/[0.06]",
    icon: "text-sodium",
    glyph: "\u26a0",
  },
  success: {
    container: "border-l-4 border-sodium bg-sodium/[0.06]",
    icon: "text-sodium",
    glyph: "\u2713",
  },
  danger: {
    container: "border-l-4 border-terra bg-terra/[0.06]",
    icon: "text-terra",
    glyph: "\u2717",
  },
} as const;

interface CalloutProps {
  type?: keyof typeof styles;
  title?: string;
  children: ReactNode;
}

/**
 * Docs-specific callout — kept under the DocsCallout name so the shared
 * @ellul.ai/marketing-mdx Callout (with type=note|warning|tip) can be the
 * canonical export. Existing docs MDX that renders <Callout type="principle">
 * is rewritten to <DocsCallout> via apps/docs/src/components/mdx/index.ts
 * during the migration window.
 */
export function DocsCallout({ type = "principle", title, children }: CalloutProps) {
  const style = styles[type];

  return (
    <div className={`not-prose my-6 rounded-r-lg p-4 ${style.container}`}>
      {title && (
        <p className="mb-1 flex items-center gap-2 text-sm font-semibold text-cream">
          <span className={style.icon}>{style.glyph}</span>
          {title}
        </p>
      )}
      <div className="text-sm text-cream/75 [&>p]:my-1">{children}</div>
    </div>
  );
}
