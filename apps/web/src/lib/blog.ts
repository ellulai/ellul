import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import matter from "gray-matter";
import { ALL_LOCALES, DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";
import { createOverlayResolver } from "@/lib/content-overlay";

const BLOG_ROOT = path.join(process.cwd(), "src", "content", "blog");

// Structural fields declared in `<slug>/meta.ts`. Translatable strings
// (title, summary, faq) live in
// `packages/i18n-messages/messages/{locale}/blog.json` and are composed in
// by the loader at request time.
export interface BlogPostStructural {
  slug: string;
  publishedAt: string;
  updatedAt?: string;
  authors: Array<{ name: string } | { handle: string }>;
  /** Primary tag, shown in the eyebrow ("Engineering · 2026-04-30"). */
  tag: string;
  /** All tags this post belongs to. If omitted, the singular `tag` is used as the only entry. */
  tags?: string[];
  ogImage?: string;
  keywords?: string[];
}

export interface BlogPostMeta extends BlogPostStructural {
  title: string;
  summary: string;
  faq?: Array<{ id: string; q: string; a: string }>;
}

/** Slugify a tag for use in /blog/tag/{slug}. */
export function tagSlug(tag: string): string {
  return tag
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** All tags a post belongs to (singular + plural sources, deduped). */
export function allTagsFor(meta: BlogPostMeta): string[] {
  const tags = new Set<string>();
  if (meta.tag) tags.add(meta.tag);
  for (const t of meta.tags ?? []) tags.add(t);
  return [...tags];
}

export interface BlogPost {
  meta: BlogPostMeta;
  content: string;
  filePath: string;
  /** Locale this post's body was loaded from. Falls back to DEFAULT_LOCALE if the
   * requested locale's MDX doesn't exist. */
  loadedLocale: Locale;
  /** Locales for which a translated MDX file exists. Used to scope hreflang. */
  availableLocales: Locale[];
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

function postDir(slug: string): string {
  return path.join(BLOG_ROOT, slug);
}

function metaPath(slug: string): string {
  return path.join(postDir(slug), "meta.ts");
}

function mdxPath(slug: string, locale: Locale): string {
  return path.join(postDir(slug), `${locale}.mdx`);
}

export function listBlogSlugs(): string[] {
  if (!fs.existsSync(BLOG_ROOT)) return [];
  return fs
    .readdirSync(BLOG_ROOT, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        fs.existsSync(metaPath(e.name)) &&
        fs.existsSync(mdxPath(e.name, DEFAULT_LOCALE)),
    )
    .map((e) => e.name);
}

export function getAvailableLocales(slug: string): Locale[] {
  return ALL_LOCALES.filter((locale) => fs.existsSync(mdxPath(slug, locale)));
}

const structuralCache = new Map<string, BlogPostStructural>();

async function loadStructural(slug: string): Promise<BlogPostStructural | null> {
  if (structuralCache.has(slug)) return structuralCache.get(slug)!;
  if (!fs.existsSync(metaPath(slug))) return null;
  const mod = await import(`../content/blog/${slug}/meta.ts`);
  const raw = (mod.default ?? mod.meta) as BlogPostStructural;
  structuralCache.set(slug, raw);
  return raw;
}

interface BlogOverlayEntry {
  title: string;
  summary: string;
  faq?: Record<string, { q: string; a: string }>;
}

const overlay = createOverlayResolver<BlogOverlayEntry>("blog");

function compose(
  structural: BlogPostStructural,
  entry: BlogOverlayEntry,
): BlogPostMeta {
  const faq = entry.faq
    ? Object.entries(entry.faq).map(([id, f]) => ({ id, q: f.q, a: f.a }))
    : undefined;
  return {
    ...structural,
    title: entry.title,
    summary: entry.summary,
    faq,
  };
}

export async function getBlogPostMeta(
  slug: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<BlogPostMeta | null> {
  const structural = await loadStructural(slug);
  if (!structural) return null;
  const entry = await overlay.resolve(slug, locale);
  if (!entry) {
    throw new Error(
      `Blog slug "${slug}" has no entry in messages/${DEFAULT_LOCALE}/blog.json`,
    );
  }
  return compose(structural, entry);
}

export async function getBlogPost(
  slug: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<BlogPost | null> {
  const meta = await getBlogPostMeta(slug, locale);
  if (!meta) return null;

  const localized = mdxPath(slug, locale);
  const fallback = mdxPath(slug, DEFAULT_LOCALE);
  const filePath = fs.existsSync(localized) ? localized : fallback;
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { content, data } = matter(raw);

  const updatedAt =
    (data.updatedAt as string | undefined) ??
    meta.updatedAt ??
    gitMtime(filePath) ??
    meta.publishedAt;

  return {
    meta: { ...meta, updatedAt },
    content,
    filePath,
    loadedLocale: filePath === localized ? locale : DEFAULT_LOCALE,
    availableLocales: getAvailableLocales(slug),
  };
}

export async function getAllBlogPosts(
  locale: Locale = DEFAULT_LOCALE,
): Promise<BlogPostMeta[]> {
  const slugs = listBlogSlugs();
  const posts: BlogPostMeta[] = [];
  for (const slug of slugs) {
    const post = await getBlogPost(slug, locale);
    if (post) posts.push(post.meta);
  }
  return posts.sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );
}
