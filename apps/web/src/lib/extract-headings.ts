export interface Heading {
  level: 2 | 3;
  text: string;
  id: string;
}

/** Lowercase, spaces to hyphens, strip non-alphanumeric (except hyphens). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Extract h2 and h3 headings from raw MDX source.
 * Matches lines starting with `## ` or `### `.
 */
export function extractHeadings(mdxSource: string): Heading[] {
  const headings: Heading[] = [];
  const lines = mdxSource.split("\n");

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match?.[1]) {
      const text = h2Match[1].trim();
      headings.push({ level: 2, text, id: slugify(text) });
      continue;
    }

    const h3Match = line.match(/^###\s+(.+)$/);
    if (h3Match?.[1]) {
      const text = h3Match[1].trim();
      headings.push({ level: 3, text, id: slugify(text) });
    }
  }

  return headings;
}
