import { Link } from "@/i18n/routing";
import type { Author } from "@/content/authors/schema";

export function AuthorCard({ author }: { author: Author }) {
  return (
    <aside
      className="!mt-12 flex items-center gap-4 rounded-2xl border border-cream/[0.06] bg-cream/[0.02] p-5"
      itemScope
      itemType="https://schema.org/Person"
    >
      <Link href={`/authors/${author.handle}`} className="shrink-0">
        {author.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={author.avatar}
            alt=""
            className="h-12 w-12 rounded-full border border-cream/[0.1]"
            itemProp="image"
          />
        ) : (
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-sodium/20 font-mono text-sm text-sodium">
            {author.name.slice(0, 1).toUpperCase()}
          </div>
        )}
      </Link>
      <div>
        <Link
          href={`/authors/${author.handle}`}
          className="text-sm font-medium text-cream hover:text-sodium"
          itemProp="name"
        >
          {author.name}
        </Link>
        <p
          className="mt-1 text-xs leading-[1.6] text-cream/55"
          itemProp="description"
        >
          {author.bio}
        </p>
        <div className="mt-2 flex items-center gap-3 text-[11px] text-cream/45">
          {author.twitter && (
            <a
              href={`https://twitter.com/${author.twitter.replace(/^@/, "")}`}
              className="hover:text-sodium"
              rel="noopener noreferrer"
              itemProp="sameAs"
            >
              @{author.twitter.replace(/^@/, "")}
            </a>
          )}
          {author.github && (
            <a
              href={`https://github.com/${author.github}`}
              className="hover:text-sodium"
              rel="noopener noreferrer"
              itemProp="sameAs"
            >
              github.com/{author.github}
            </a>
          )}
        </div>
      </div>
    </aside>
  );
}
