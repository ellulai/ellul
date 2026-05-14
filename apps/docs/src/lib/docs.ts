import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import matter from "gray-matter";
import { ALL_LOCALES, DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";

const CONTENT_ROOT = path.join(process.cwd(), "src", "content");

function localeDir(locale: Locale): string {
  return path.join(CONTENT_ROOT, locale);
}

export interface DocMeta {
  slug: string;
  title: string;
  description: string;
  order: number;
  section: string;
  publishedAt?: string;
  updatedAt: string;
}

export interface Doc extends DocMeta {
  content: string;
  filePath: string;
}

function gitMtime(filePath: string): string | null {
  try {
    const out = execSync(`git log -1 --format=%cI -- "${filePath}"`, {
      cwd: path.dirname(filePath),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

function fileMtime(filePath: string): string {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function getMdxFiles(dir: string, prefix = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getMdxFiles(fullPath, `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith(".mdx")) {
      files.push(`${prefix}${entry.name.replace(/\.mdx$/, "")}`);
    }
  }

  return files;
}

/**
 * Returns the union of slugs across all locales' content dirs. Used for
 * `generateStaticParams` so every (locale × slug) URL is prerendered, with
 * locales that haven't translated a given slug falling back to English at
 * file-read time (see `getDocBySlug`).
 */
export function getAllSlugs(): string[][] {
  const enFiles = getMdxFiles(localeDir(DEFAULT_LOCALE));
  return Array.from(new Set(enFiles)).map((slug) => slug.split("/"));
}

/**
 * Reads an MDX file for a given (slug, locale). Falls back to the English
 * file if the locale-specific version doesn't exist yet — keeps the routes
 * reachable while translation is in progress.
 */
export function getDocBySlug(slug: string[], locale: Locale = DEFAULT_LOCALE): Doc | null {
  const relPath = `${slug.join("/")}.mdx`;
  const localized = path.join(localeDir(locale), relPath);
  const fallback = path.join(localeDir(DEFAULT_LOCALE), relPath);
  const filePath = fs.existsSync(localized) ? localized : fallback;

  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { data, content } = matter(raw);

  const updatedAt =
    (data.updatedAt as string | undefined) ??
    gitMtime(filePath) ??
    fileMtime(filePath);

  return {
    slug: slug.join("/"),
    title: (data.title as string) ?? slug[slug.length - 1] ?? "",
    description: (data.description as string) ?? "",
    order: (data.order as number) ?? 999,
    section: (data.section as string) ?? "General",
    publishedAt: (data.publishedAt as string | undefined) ?? undefined,
    updatedAt,
    content,
    filePath,
  };
}

/**
 * Returns the locales that have a translated MDX file for a given slug. Used
 * to scope hreflang to only the locales where the page actually exists.
 */
export function getLocalesForSlug(slug: string[]): Locale[] {
  const relPath = `${slug.join("/")}.mdx`;
  return ALL_LOCALES.filter((locale) =>
    fs.existsSync(path.join(localeDir(locale), relPath)),
  );
}

export function getAllDocs(locale: Locale = DEFAULT_LOCALE): DocMeta[] {
  const slugs = getAllSlugs();
  const out: DocMeta[] = [];
  for (const slug of slugs) {
    const doc = getDocBySlug(slug, locale);
    if (!doc) continue;
    out.push({
      slug: doc.slug,
      title: doc.title,
      description: doc.description,
      order: doc.order,
      section: doc.section,
      publishedAt: doc.publishedAt,
      updatedAt: doc.updatedAt,
    });
  }
  return out.sort((a, b) => a.order - b.order);
}

export function getDocsBySection(locale: Locale = DEFAULT_LOCALE): Record<string, DocMeta[]> {
  const docs = getAllDocs(locale);
  const sections: Record<string, DocMeta[]> = {};

  for (const doc of docs) {
    const existing = sections[doc.section];
    if (existing) {
      existing.push(doc);
    } else {
      sections[doc.section] = [doc];
    }
  }

  return sections;
}
