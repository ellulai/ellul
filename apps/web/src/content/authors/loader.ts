import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";
import { createOverlayResolver } from "@/lib/content-overlay";
import { AuthorSchema, type Author, type AuthorStructural } from "./schema";

const AUTHORS_ROOT = path.join(process.cwd(), "src", "content", "authors");
const RESERVED = new Set(["schema", "loader", "index"]);

export function listAuthorHandles(): string[] {
  if (!fs.existsSync(AUTHORS_ROOT)) return [];
  return fs
    .readdirSync(AUTHORS_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => e.name.replace(/\.ts$/, ""))
    .filter((h) => !RESERVED.has(h));
}

const structuralCache = new Map<string, AuthorStructural>();

async function loadStructural(handle: string): Promise<AuthorStructural | null> {
  if (structuralCache.has(handle)) return structuralCache.get(handle)!;
  if (RESERVED.has(handle)) return null;
  const filePath = path.join(AUTHORS_ROOT, `${handle}.ts`);
  if (!fs.existsSync(filePath)) return null;
  const mod = await import(`./${handle}.ts`);
  const raw = (mod.default ?? mod.author) as unknown;
  const parsed = AuthorSchema.parse(raw);
  if (parsed.handle !== handle) {
    throw new Error(
      `Author handle mismatch: ${handle}.ts declares handle "${parsed.handle}"`,
    );
  }
  structuralCache.set(handle, parsed);
  return parsed;
}

interface AuthorOverlayEntry {
  name: string;
  bio: string;
  jobTitle?: string;
}

const overlay = createOverlayResolver<AuthorOverlayEntry>("authors");

function compose(
  structural: AuthorStructural,
  entry: AuthorOverlayEntry,
): Author {
  return {
    ...structural,
    name: entry.name,
    bio: entry.bio,
    jobTitle: entry.jobTitle,
  };
}

export async function getAuthor(
  handle: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<Author | null> {
  const structural = await loadStructural(handle);
  if (!structural) return null;
  const entry = await overlay.resolve(handle, locale);
  if (!entry) {
    throw new Error(
      `Author handle "${handle}" has no entry in messages/${DEFAULT_LOCALE}/authors.json`,
    );
  }
  return compose(structural, entry);
}

export async function getAuthorsByHandles(
  handles: string[],
  locale: Locale = DEFAULT_LOCALE,
): Promise<Author[]> {
  const out: Author[] = [];
  for (const h of handles) {
    const a = await getAuthor(h, locale);
    if (a) out.push(a);
  }
  return out;
}

export async function getAllAuthors(
  locale: Locale = DEFAULT_LOCALE,
): Promise<Author[]> {
  const handles = listAuthorHandles();
  return getAuthorsByHandles(handles, locale);
}
