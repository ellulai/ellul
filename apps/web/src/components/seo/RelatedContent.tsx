import { Link } from "@/i18n/routing";
import type { Locale } from "@ellul.ai/i18n-consts";
import {
  getRelatedContent,
  type ContentType,
  type ContentLink,
} from "@/lib/content-graph";

interface Props {
  slug: string;
  contentType: ContentType;
  locale: Locale;
}

const SECTION_LABELS: Record<ContentType, string> = {
  comparison: "Related comparisons",
  pillar: "Explore concepts",
  "use-case": "Solutions",
  blog: "From the blog",
  glossary: "Glossary",
  agent: "Agents",
  mcp: "MCP",
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

function LinkCard({ link }: { link: ContentLink }) {
  return (
    <Link
      href={link.href}
      className="group block rounded-xl border border-cream/[0.06] bg-cream/[0.015] p-4 transition hover:border-cream/[0.14] hover:bg-cream/[0.03]"
    >
      <p className="text-sm font-light leading-snug tracking-[-0.01em] text-cream group-hover:text-sodium">
        {link.title}
      </p>
      {link.description && (
        <p className="mt-1.5 text-xs leading-[1.6] text-cream/45">
          {truncate(link.description, 100)}
        </p>
      )}
    </Link>
  );
}

export async function RelatedContent({ slug, contentType, locale }: Props) {
  const related = await getRelatedContent(slug, contentType, locale, 3);

  const sections = (Object.keys(related) as ContentType[]).filter(
    (type) => related[type].length > 0,
  );

  if (sections.length === 0) return null;

  return (
    <aside
      aria-label="Related content"
      className="relative z-10 w-full max-w-5xl pb-14"
    >
      <div className="border-t border-cream/[0.06] pt-10">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {sections.map((type) => (
            <div key={type}>
              <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/40">
                {SECTION_LABELS[type]}
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {related[type].map((link) => (
                  <LinkCard key={`${link.type}:${link.slug}`} link={link} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
