// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Vault Index Service
 *
 * Core indexing engine for the Scoped Knowledge Vault. Maintains a per-project
 * SQLite FTS5 index derived from markdown files on disk.
 *
 * Responsibilities:
 *   - SQLite schema creation and migration (per-project DB in shield-data)
 *   - Markdown parsing: frontmatter, headings, blocks, wiki-links, tags, inline fields
 *   - Wiki-link resolution: Obsidian-compatible basename-first shortest-path
 *   - FTS5 full-text search index maintenance
 *   - Note CRUD (index-side; file operations delegated to caller)
 *   - Attachment registration
 *
 * Security:
 *   - Index DBs live in /etc/ellul/shield-data/vault-idx/ (agent cannot access)
 *   - Edges are RAW parsed relationships, not authorized views
 *   - All query results must pass through vault-scope.service before reaching any principal
 *   - Graph traversal is always executed against the principal-resolved scoped graph view
 *
 * Files on disk are source of truth; the index is derived and rebuildable.
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  VAULT_INDEX_DIR,
  VAULT_MAX_NOTE_SIZE,
  VAULT_NOTE_EXTENSIONS,
  ALLOWED_ATTACHMENT_MIMES,
  computeNoteId,
  type ParsedNote,
  type ParsedLink,
  type VaultNote,
  type VaultHeading,
  type VaultBlock,
  type VaultEdge,
  type VaultAttachment,
  type VaultIndexStatus,
  type LinkType,
  type FragmentType,
  type SearchResult,
} from '@vps/shared/vault-types';
import { SVC_HOME, SHIELD_DATA_DIR } from '../../config';

// ═══════════════════════════════════════════════════════════════════
// Per-Project Database Management
// ═══════════════════════════════════════════════════════════════════

const openDbs = new Map<string, Database>();

/**
 * Get or create the vault index database for a project.
 * Each project has its own SQLite DB file in shield-data/vault-idx/.
 */
export function getVaultDb(project: string): Database {
  validateProjectSlug(project);

  const existing = openDbs.get(project);
  if (existing) return existing;

  // Ensure vault-idx directory exists (including subdirs for nested projects)
  const dbPath = path.join(VAULT_INDEX_DIR, `${project}.db`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  // Lock down permissions — agent must not read index DB
  try { fs.chmodSync(dbPath, 0o600); } catch {}

  initSchema(db);
  openDbs.set(project, db);
  return db;
}

/**
 * Close a project's vault DB. Called on project deletion or shutdown.
 */
export function closeVaultDb(project: string): void {
  const db = openDbs.get(project);
  if (db) {
    db.close();
    openDbs.delete(project);
  }
}

/**
 * Close all open vault databases. Called on process shutdown.
 */
export function closeAllVaultDbs(): void {
  for (const [project, db] of openDbs) {
    try { db.close(); } catch {}
    openDbs.delete(project);
  }
}

/**
 * Validate a vault project slug. The canonical scope for vault notes is the
 * sandbox — use `parseSandboxId` from `@ellul.ai/types` at every public API
 * boundary. This helper exists for defense-in-depth inside the service
 * itself; it's cheap and catches any caller that slipped past the boundary.
 */
function validateProjectSlug(project: string): void {
  if (!/^sbx-[a-z0-9]{7}$/.test(project)) {
    throw new Error(`Invalid vault sandbox slug: '${project}'`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Schema Initialization
// ═══════════════════════════════════════════════════════════════════

function initSchema(db: Database): void {
  db.exec(`
    -- ── Notes (derived from vault root markdown files) ──
    -- Note IDs are deterministic: sha256(project:path)[0:16]
    -- Stable across index rebuilds. Changes on rename.
    CREATE TABLE IF NOT EXISTS notes (
      id           TEXT PRIMARY KEY,
      path         TEXT NOT NULL UNIQUE,
      title        TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      frontmatter  TEXT,
      tags         TEXT,
      aliases      TEXT,
      word_count   INTEGER NOT NULL DEFAULT 0,
      size_bytes   INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      modified_at  INTEGER NOT NULL,
      indexed_at   INTEGER NOT NULL
    );

    -- ── Full-Text Search ──
    -- Tokenizer choice: unicode61 without stemmer initially.
    -- Abstracted behind index rebuild — tokenizer strategy can evolve without migration.
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      title, content, tags,
      content='notes', content_rowid=rowid,
      tokenize='unicode61'
    );

    -- Triggers to keep FTS in sync with notes table
    CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, title, content, tags)
      VALUES (new.rowid, new.title, '', COALESCE(new.tags, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, '', COALESCE(old.tags, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, '', COALESCE(old.tags, ''));
      INSERT INTO notes_fts(rowid, title, content, tags)
      VALUES (new.rowid, new.title, '', COALESCE(new.tags, ''));
    END;

    -- ── Headings ──
    CREATE TABLE IF NOT EXISTS headings (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      level   INTEGER NOT NULL,
      text    TEXT NOT NULL,
      slug    TEXT NOT NULL,
      offset  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_headings_note_slug ON headings(note_id, slug);

    -- ── Block References ──
    CREATE TABLE IF NOT EXISTS blocks (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      block_id TEXT NOT NULL,
      offset   INTEGER NOT NULL,
      preview  TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_note_block ON blocks(note_id, block_id);

    -- ── Edges (raw parsed relationships — NOT authorized views) ──
    CREATE TABLE IF NOT EXISTS edges (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      target_id      TEXT REFERENCES notes(id) ON DELETE SET NULL,
      raw_link       TEXT NOT NULL,
      target_path    TEXT,
      link_type      TEXT NOT NULL CHECK(link_type IN ('wikilink', 'embed', 'markdown_link')),
      fragment_type  TEXT CHECK(fragment_type IN (NULL, 'heading', 'block')),
      fragment_id    TEXT,
      source_offset  INTEGER NOT NULL,
      display_text   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

    -- ── Scopes (named projections) ──
    CREATE TABLE IF NOT EXISTS scopes (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL UNIQUE,
      description      TEXT,
      rules            TEXT NOT NULL,
      is_agent_default INTEGER NOT NULL DEFAULT 0,
      version          INTEGER NOT NULL DEFAULT 1,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    -- ── Materialized Scope Membership ──
    -- Materialized at scope level; principal restrictions applied at query time.
    CREATE TABLE IF NOT EXISTS scope_membership (
      scope_id INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
      note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      PRIMARY KEY (scope_id, note_id)
    );

    -- ── Attachments ──
    CREATE TABLE IF NOT EXISTS attachments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      path         TEXT NOT NULL UNIQUE,
      mime_type    TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      indexed_at   INTEGER NOT NULL
    );

    -- ── Share Links (human UX navigation) ──
    CREATE TABLE IF NOT EXISTS share_links (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      token          TEXT NOT NULL UNIQUE,
      note_id        TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      fragment_type  TEXT,
      fragment_id    TEXT,
      created_by     TEXT NOT NULL,
      sharing_policy TEXT NOT NULL DEFAULT 'internal',
      max_uses       INTEGER,
      use_count      INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL,
      expires_at     INTEGER,
      revoked_at     INTEGER
    );

    -- ── Capability Tokens (session-bound access artifacts) ──
    CREATE TABLE IF NOT EXISTS capability_tokens (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      token            TEXT NOT NULL UNIQUE,
      note_id          TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      fragment_type    TEXT,
      fragment_id      TEXT,
      scope_id         INTEGER REFERENCES scopes(id) ON DELETE SET NULL,
      session_id       TEXT NOT NULL,
      vault_session_id TEXT,
      principal_type   TEXT NOT NULL,
      max_uses         INTEGER NOT NULL DEFAULT 1,
      use_count        INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL,
      expires_at       INTEGER NOT NULL,
      revoked_at       INTEGER
    );

    -- ── Vault Sessions (agent scope binding) ──
    CREATE TABLE IF NOT EXISTS vault_sessions (
      id              TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      project         TEXT NOT NULL,
      scope_id        INTEGER NOT NULL,
      scope_name      TEXT NOT NULL,
      phantom_key     TEXT NOT NULL,
      projection_ver  INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL
    );
  `);
}

// ═══════════════════════════════════════════════════════════════════
// Markdown Parsing
// ═══════════════════════════════════════════════════════════════════

// ── Frontmatter ──

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown> | null; bodyStart: number } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: null, bodyStart: 0 };

  const yamlStr = match[1]!;
  const bodyStart = match[0]!.length;

  // Simple YAML parser — handles key: value, key: [array], and multiline
  // Full YAML parsing deferred to gray-matter on the client side.
  // Server-side we need: tags, aliases, title, and arbitrary key-value.
  const fm: Record<string, unknown> = {};
  let currentKey = '';
  let inArray = false;
  const arrayValues: string[] = [];

  for (const line of yamlStr.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (inArray && trimmed.startsWith('- ')) {
      arrayValues.push(trimmed.slice(2).trim().replace(/^['"]|['"]$/g, ''));
      continue;
    } else if (inArray) {
      fm[currentKey] = arrayValues.slice();
      arrayValues.length = 0;
      inArray = false;
    }

    const kvMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)/);
    if (kvMatch) {
      const key = kvMatch[1]!;
      const value = kvMatch[2]!.trim();

      if (value === '' || value === '|' || value === '>') {
        // Could be start of array or multiline — check next lines
        currentKey = key;
        inArray = true;
        arrayValues.length = 0;
        continue;
      }

      // Inline array: [val1, val2]
      if (value.startsWith('[') && value.endsWith(']')) {
        fm[key] = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        continue;
      }

      // Boolean
      if (value === 'true') { fm[key] = true; continue; }
      if (value === 'false') { fm[key] = false; continue; }

      // Number
      const num = Number(value);
      if (!isNaN(num) && value !== '') { fm[key] = num; continue; }

      // String (strip quotes)
      fm[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }

  // Flush any pending array
  if (inArray && currentKey) {
    fm[currentKey] = arrayValues.slice();
  }

  return { frontmatter: Object.keys(fm).length > 0 ? fm : null, bodyStart };
}

// ── Tags ──

// Inline tags: #tag, #parent/child (must have at least one non-numeric char)
const TAG_RE = /(?:^|\s)#([a-zA-Z_][a-zA-Z0-9_\-/]*)/g;

function extractTags(content: string, frontmatter: Record<string, unknown> | null): string[] {
  const tags = new Set<string>();

  // Frontmatter tags
  const fmTags = frontmatter?.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) {
      if (typeof t === 'string') tags.add(t.startsWith('#') ? t.slice(1) : t);
    }
  } else if (typeof fmTags === 'string') {
    tags.add(fmTags.startsWith('#') ? fmTags.slice(1) : fmTags);
  }

  // Inline tags (skip code blocks and comments)
  const withoutCode = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/%%[\s\S]*?%%/g, '');

  let match;
  while ((match = TAG_RE.exec(withoutCode)) !== null) {
    tags.add(match[1]!);
  }

  return [...tags].sort();
}

// ── Headings ──

const HEADING_RE = /^(#{1,6})\s+(.+)$/gm;

function extractHeadings(content: string): VaultHeading[] {
  const headings: VaultHeading[] = [];
  let match;
  while ((match = HEADING_RE.exec(content)) !== null) {
    headings.push({
      level: match[1]!.length,
      text: match[2]!.trim(),
      slug: slugify(match[2]!.trim()),
      offset: match.index,
    });
  }
  return headings;
}

/**
 * Slugify a heading for #heading link resolution.
 * Matches Obsidian behavior: lowercase, spaces → hyphens, strip special chars.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

// ── Block References ──

// Block IDs: any paragraph/list/block ending with ^block-id
const BLOCK_REF_RE = /\s\^([a-zA-Z0-9-]+)\s*$/gm;

function extractBlocks(content: string): VaultBlock[] {
  const blocks: VaultBlock[] = [];
  let match;
  while ((match = BLOCK_REF_RE.exec(content)) !== null) {
    const blockId = match[1]!;
    // Extract preview: up to 200 chars before the ^block-id
    const lineStart = content.lastIndexOf('\n', match.index) + 1;
    const preview = content.slice(lineStart, match.index).trim().slice(0, 200);
    blocks.push({
      blockId,
      offset: match.index,
      preview,
    });
  }
  return blocks;
}

// ── Wiki-Links and Embeds ──

// Matches: [[target]], [[target|alias]], [[target#heading]], [[target#^block]]
// Also matches embeds: ![[target]], ![[target|size]]
const WIKILINK_RE = /(!?)\[\[([^\]|#]+)(?:#(\^?)([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

// Standard markdown links: [text](url)
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

function extractLinks(content: string): ParsedLink[] {
  const links: ParsedLink[] = [];

  // Skip code blocks and comments
  const withoutCode = content
    .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
    .replace(/%%[\s\S]*?%%/g, (m) => ' '.repeat(m.length));

  // Wiki-links and embeds
  let match;
  while ((match = WIKILINK_RE.exec(withoutCode)) !== null) {
    const isEmbed = match[1] === '!';
    const target = match[2]!.trim();
    const isBlock = match[3] === '^';
    const fragment = match[4]?.trim() || null;
    const alias = match[5]?.trim() || null;

    links.push({
      rawLink: fragment ? `${target}#${isBlock ? '^' : ''}${fragment}` : target,
      linkType: isEmbed ? 'embed' : 'wikilink',
      fragmentType: fragment ? (isBlock ? 'block' : 'heading') : null,
      fragmentId: fragment,
      offset: match.index,
      displayText: alias,
    });
  }

  // Standard markdown links (only internal .md links, not external URLs)
  while ((match = MD_LINK_RE.exec(withoutCode)) !== null) {
    const url = match[2]!;
    // Skip external URLs
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) continue;
    // Skip anchors
    if (url.startsWith('#')) continue;

    let target = url;
    let fragmentType: FragmentType | null = null;
    let fragmentId: string | null = null;

    const hashIdx = url.indexOf('#');
    if (hashIdx !== -1) {
      target = url.slice(0, hashIdx);
      const frag = url.slice(hashIdx + 1);
      if (frag.startsWith('^')) {
        fragmentType = 'block';
        fragmentId = frag.slice(1);
      } else {
        fragmentType = 'heading';
        fragmentId = frag;
      }
    }

    links.push({
      rawLink: url,
      linkType: 'markdown_link',
      fragmentType,
      fragmentId,
      offset: match.index,
      displayText: match[1] || null,
    });
  }

  return links;
}

// ── Inline Fields ──
// key:: value (Dataview convention)
const INLINE_FIELD_RE = /^([a-zA-Z][a-zA-Z0-9_-]*)::\s*(.+)$/gm;

// ── Word Count ──

function countWords(text: string): number {
  // Strip frontmatter, code blocks, comments
  const clean = text
    .replace(FRONTMATTER_RE, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/%%[\s\S]*?%%/g, '');
  const words = clean.match(/\S+/g);
  return words ? words.length : 0;
}

// ── Title Extraction ──

function extractTitle(content: string, frontmatter: Record<string, unknown> | null, filePath: string): string {
  // 1. Frontmatter title
  if (typeof frontmatter?.title === 'string' && frontmatter.title.trim()) {
    return frontmatter.title.trim();
  }

  // 2. First H1
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1]!.trim();

  // 3. Filename without extension
  return path.basename(filePath, path.extname(filePath));
}

// ── Full Parse ──

/**
 * Parse a markdown file into structured components.
 * This is a pure function — no database or filesystem access.
 */
export function parseMarkdown(content: string, filePath: string): ParsedNote {
  const { frontmatter, bodyStart } = parseFrontmatter(content);
  const body = content.slice(bodyStart);
  const tags = extractTags(body, frontmatter);
  const headings = extractHeadings(body);
  const blocks = extractBlocks(body);
  const links = extractLinks(body);
  const wordCount = countWords(content);
  const title = extractTitle(content, frontmatter, filePath);

  // Extract aliases from frontmatter
  const aliases: string[] = [];
  const fmAliases = frontmatter?.aliases;
  if (Array.isArray(fmAliases)) {
    for (const a of fmAliases) {
      if (typeof a === 'string' && a.trim()) aliases.push(a.trim());
    }
  } else if (typeof fmAliases === 'string' && fmAliases.trim()) {
    aliases.push(fmAliases.trim());
  }

  return { title, frontmatter, tags, aliases, headings, blocks, links, wordCount };
}

// ═══════════════════════════════════════════════════════════════════
// Wiki-Link Resolution (Obsidian-Compatible)
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve a wiki-link target to a note path using Obsidian's algorithm:
 *
 * 1. Strip .md extension and fragment (#heading, #^block)
 * 2. Case-insensitive lookup in note basename index
 * 3. If unique match → resolved
 * 4. If multiple matches → prefer shortest relative path from source note
 * 5. If link contains '/' → path suffix match against all note paths
 * 6. Check frontmatter aliases
 * 7. If no match → unresolved (returns null)
 */
export function resolveWikiLink(
  rawTarget: string,
  sourcePath: string,
  noteIndex: Map<string, string[]>,  // lowercase basename → [paths]
  aliasIndex: Map<string, string>,   // lowercase alias → path
): string | null {
  // Strip fragment
  let target = rawTarget;
  const hashIdx = target.indexOf('#');
  if (hashIdx !== -1) target = target.slice(0, hashIdx);

  // Strip .md extension
  target = target.replace(/\.md$/i, '').trim();
  if (!target) return null;

  const targetLower = target.toLowerCase();

  // If target contains '/' → path suffix match
  if (target.includes('/')) {
    const suffixLower = targetLower.endsWith('.md') ? targetLower : targetLower;
    for (const [, paths] of noteIndex) {
      for (const p of paths) {
        const pLower = p.toLowerCase().replace(/\.md$/i, '');
        if (pLower.endsWith(suffixLower) || pLower === suffixLower) {
          return p;
        }
      }
    }
  }

  // Basename match (case-insensitive)
  const candidates = noteIndex.get(targetLower);
  if (candidates && candidates.length === 1) {
    return candidates[0]!;
  }

  if (candidates && candidates.length > 1) {
    // Multiple matches — prefer shortest relative path from source
    const sourceDir = path.dirname(sourcePath);
    let best: string | null = null;
    let bestLen = Infinity;
    for (const p of candidates) {
      const rel = path.relative(sourceDir, path.dirname(p));
      const segments = rel === '' ? 0 : rel.split('/').length;
      if (segments < bestLen) {
        bestLen = segments;
        best = p;
      }
    }
    return best;
  }

  // Check aliases
  const aliasMatch = aliasIndex.get(targetLower);
  if (aliasMatch) return aliasMatch;

  return null;
}

/**
 * Build the basename and alias indexes for link resolution.
 */
export function buildResolutionIndexes(db: Database): {
  noteIndex: Map<string, string[]>;
  aliasIndex: Map<string, string>;
} {
  const noteIndex = new Map<string, string[]>();
  const aliasIndex = new Map<string, string>();

  const rows = db.prepare('SELECT id, path, aliases FROM notes').all() as Array<{
    id: string;
    path: string;
    aliases: string | null;
  }>;

  for (const row of rows) {
    // Index by lowercase basename (without extension)
    const basename = path.basename(row.path, path.extname(row.path)).toLowerCase();
    const existing = noteIndex.get(basename);
    if (existing) {
      existing.push(row.path);
    } else {
      noteIndex.set(basename, [row.path]);
    }

    // Index aliases
    if (row.aliases) {
      try {
        const aliases = JSON.parse(row.aliases) as string[];
        for (const alias of aliases) {
          if (typeof alias === 'string' && alias.trim()) {
            aliasIndex.set(alias.trim().toLowerCase(), row.path);
          }
        }
      } catch {}
    }
  }

  return { noteIndex, aliasIndex };
}

// ═══════════════════════════════════════════════════════════════════
// Note Indexing
// ═══════════════════════════════════════════════════════════════════

/**
 * Index a single note file. Parses the markdown, computes deterministic ID,
 * and upserts into the index DB. Does NOT resolve links (call resolveAllLinks
 * after all notes are indexed).
 */
export function indexNote(
  db: Database,
  project: string,
  relativePath: string,
  content: string,
  stat: { size: number; mtimeMs: number; birthtimeMs: number },
): VaultNote {
  const noteId = computeNoteId(project, relativePath);
  const contentHash = crypto.createHash('sha256').update(content).digest('hex');

  // Check if already indexed with same content hash (skip reparse)
  const existing = db.prepare('SELECT content_hash FROM notes WHERE id = ?').get(noteId) as
    { content_hash: string } | undefined;
  if (existing?.content_hash === contentHash) {
    // Content unchanged — just update modified_at if different
    db.prepare('UPDATE notes SET modified_at = ?, indexed_at = ? WHERE id = ?')
      .run(Math.floor(stat.mtimeMs), Date.now(), noteId);
    return getNoteById(db, project, noteId)!;
  }

  const parsed = parseMarkdown(content, relativePath);

  // Upsert note
  db.prepare(`
    INSERT INTO notes (id, path, title, content_hash, frontmatter, tags, aliases, word_count, size_bytes, created_at, modified_at, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      path = excluded.path,
      title = excluded.title,
      content_hash = excluded.content_hash,
      frontmatter = excluded.frontmatter,
      tags = excluded.tags,
      aliases = excluded.aliases,
      word_count = excluded.word_count,
      size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at,
      indexed_at = excluded.indexed_at
  `).run(
    noteId,
    relativePath,
    parsed.title,
    contentHash,
    parsed.frontmatter ? JSON.stringify(parsed.frontmatter) : null,
    parsed.tags.length > 0 ? JSON.stringify(parsed.tags) : null,
    parsed.aliases.length > 0 ? JSON.stringify(parsed.aliases) : null,
    parsed.wordCount,
    stat.size,
    Math.floor(stat.birthtimeMs),
    Math.floor(stat.mtimeMs),
    Date.now(),
  );

  // Update FTS content
  db.prepare(`
    INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
    VALUES ('delete', (SELECT rowid FROM notes WHERE id = ?), ?, '', ?)
  `).run(noteId, parsed.title, parsed.tags.length > 0 ? JSON.stringify(parsed.tags) : '');
  db.prepare(`
    INSERT INTO notes_fts(rowid, title, content, tags)
    VALUES ((SELECT rowid FROM notes WHERE id = ?), ?, ?, ?)
  `).run(noteId, parsed.title, content.slice(parsed.frontmatter ? content.indexOf('---', 3) + 3 : 0), parsed.tags.join(' '));

  // Replace headings
  db.prepare('DELETE FROM headings WHERE note_id = ?').run(noteId);
  const insertHeading = db.prepare(
    'INSERT INTO headings (note_id, level, text, slug, offset) VALUES (?, ?, ?, ?, ?)',
  );
  for (const h of parsed.headings) {
    insertHeading.run(noteId, h.level, h.text, h.slug, h.offset);
  }

  // Replace blocks
  db.prepare('DELETE FROM blocks WHERE note_id = ?').run(noteId);
  const insertBlock = db.prepare(
    'INSERT INTO blocks (note_id, block_id, offset, preview) VALUES (?, ?, ?, ?)',
  );
  for (const b of parsed.blocks) {
    insertBlock.run(noteId, b.blockId, b.offset, b.preview);
  }

  // Replace raw edges (unresolved — target_id set later by resolveAllLinks)
  db.prepare('DELETE FROM edges WHERE source_id = ?').run(noteId);
  const insertEdge = db.prepare(
    'INSERT INTO edges (source_id, target_id, raw_link, target_path, link_type, fragment_type, fragment_id, source_offset, display_text) VALUES (?, NULL, ?, NULL, ?, ?, ?, ?, ?)',
  );
  for (const link of parsed.links) {
    insertEdge.run(
      noteId,
      link.rawLink,
      link.linkType,
      link.fragmentType,
      link.fragmentId,
      link.offset,
      link.displayText,
    );
  }

  return {
    id: noteId,
    project,
    path: relativePath,
    title: parsed.title,
    frontmatter: parsed.frontmatter,
    tags: parsed.tags,
    aliases: parsed.aliases,
    wordCount: parsed.wordCount,
    sizeBytes: stat.size,
    createdAt: Math.floor(stat.birthtimeMs),
    modifiedAt: Math.floor(stat.mtimeMs),
  };
}

/**
 * Resolve all wiki-links in the database after notes are indexed.
 * Builds the basename/alias indexes and resolves each edge's target.
 */
export function resolveAllLinks(db: Database, project: string): number {
  const { noteIndex, aliasIndex } = buildResolutionIndexes(db);

  // Build path → id map
  const pathToId = new Map<string, string>();
  const rows = db.prepare('SELECT id, path FROM notes').all() as Array<{ id: string; path: string }>;
  for (const row of rows) {
    pathToId.set(row.path, row.id);
  }

  // Resolve each unresolved edge
  const unresolvedEdges = db.prepare(
    'SELECT e.id, e.raw_link, e.link_type, n.path as source_path FROM edges e JOIN notes n ON n.id = e.source_id WHERE e.target_id IS NULL',
  ).all() as Array<{ id: number; raw_link: string; link_type: string; source_path: string }>;

  const updateEdge = db.prepare(
    'UPDATE edges SET target_id = ?, target_path = ? WHERE id = ?',
  );

  let resolved = 0;
  for (const edge of unresolvedEdges) {
    const targetPath = resolveWikiLink(edge.raw_link, edge.source_path, noteIndex, aliasIndex);
    if (targetPath) {
      const targetId = pathToId.get(targetPath);
      if (targetId) {
        updateEdge.run(targetId, targetPath, edge.id);
        resolved++;
      }
    }
  }

  return resolved;
}

// ═══════════════════════════════════════════════════════════════════
// Full Vault Rebuild
// ═══════════════════════════════════════════════════════════════════

/**
 * Get the vault root directory for a project.
 * The vault root is the project directory itself — imported Obsidian vaults
 * preserve their relative structure. The .obsidian/ directory is ignored.
 */
export function getVaultRoot(project: string): string {
  return path.join(SVC_HOME, 'projects', project);
}

/**
 * Walk the vault root and return all markdown file paths (relative to vault root).
 */
function walkVaultFiles(vaultRoot: string, extensions: ReadonlySet<string>): string[] {
  const files: string[] = [];

  function walk(dir: string, prefix: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      // Skip hidden files/dirs, node_modules, .git, .obsidian
      if (name.startsWith('.') || name === 'node_modules' || name === '.obsidian') continue;

      const fullPath = path.join(dir, name);
      const relPath = prefix ? `${prefix}/${name}` : name;

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (extensions.has(ext)) {
          files.push(relPath);
        }
      }
      // Symlinks are skipped (no entry.isSymbolicLink() handling — defense against symlink-to-secret)
    }
  }

  walk(vaultRoot, '');
  return files;
}

/**
 * Rebuild the entire vault index from scratch.
 * Walks all markdown files, parses them, indexes them, and resolves all links.
 * Returns the number of notes indexed.
 */
export function rebuildVaultIndex(project: string): { noteCount: number; edgeCount: number; resolved: number } {
  const db = getVaultDb(project);
  const vaultRoot = getVaultRoot(project);

  if (!fs.existsSync(vaultRoot)) {
    return { noteCount: 0, edgeCount: 0, resolved: 0 };
  }

  // Clear existing data (rebuild from scratch)
  db.exec('DELETE FROM edges');
  db.exec('DELETE FROM headings');
  db.exec('DELETE FROM blocks');
  db.exec('DELETE FROM notes');
  // FTS triggers handle cleanup

  const files = walkVaultFiles(vaultRoot, VAULT_NOTE_EXTENSIONS);

  // Index all notes in a transaction
  const indexTransaction = db.transaction(() => {
    for (const relPath of files) {
      const fullPath = path.join(vaultRoot, relPath);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > VAULT_MAX_NOTE_SIZE) continue; // Skip oversized files
        const content = fs.readFileSync(fullPath, 'utf8');
        indexNote(db, project, relPath, content, stat);
      } catch {
        // Skip unreadable files
      }
    }
  });
  indexTransaction();

  // Resolve all links
  const resolved = resolveAllLinks(db, project);

  const noteCount = (db.prepare('SELECT COUNT(*) as c FROM notes').get() as { c: number }).c;
  const edgeCount = (db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;

  return { noteCount, edgeCount, resolved };
}

// ═══════════════════════════════════════════════════════════════════
// Note Queries
// ═══════════════════════════════════════════════════════════════════

function rowToNote(row: any, project: string): VaultNote {
  return {
    id: row.id,
    project,
    path: row.path,
    title: row.title,
    frontmatter: row.frontmatter ? JSON.parse(row.frontmatter) : null,
    tags: row.tags ? JSON.parse(row.tags) : [],
    aliases: row.aliases ? JSON.parse(row.aliases) : [],
    wordCount: row.word_count,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}

export function getNoteById(db: Database, project: string, noteId: string): VaultNote | null {
  const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
  return row ? rowToNote(row, project) : null;
}

export function getNoteByPath(db: Database, project: string, notePath: string): VaultNote | null {
  const row = db.prepare('SELECT * FROM notes WHERE path = ?').get(notePath);
  return row ? rowToNote(row, project) : null;
}

export function listNotes(db: Database, project: string, opts?: {
  pathPrefix?: string;
  limit?: number;
  offset?: number;
}): { notes: VaultNote[]; total: number } {
  let whereClause = '';
  const params: unknown[] = [];

  if (opts?.pathPrefix) {
    whereClause = 'WHERE path LIKE ?';
    params.push(`${opts.pathPrefix}%`);
  }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM notes ${whereClause}`).get(...params) as { c: number }).c;

  const limit = opts?.limit ?? 100;
  const offset = opts?.offset ?? 0;
  params.push(limit, offset);

  const rows = db.prepare(
    `SELECT * FROM notes ${whereClause} ORDER BY path ASC LIMIT ? OFFSET ?`,
  ).all(...params);

  return {
    notes: rows.map((r: any) => rowToNote(r, project)),
    total,
  };
}

/**
 * Full-text search across the vault.
 * Returns note IDs + snippets. Caller must filter by scope membership.
 */
export function searchNotes(db: Database, project: string, query: string, limit = 20): SearchResult[] {
  if (!query.trim()) return [];

  // Escape FTS5 special characters in user query
  const escaped = query.replace(/['"*(){}[\]:]/g, ' ').trim();
  if (!escaped) return [];

  const rows = db.prepare(`
    SELECT n.id, n.path, n.title,
           snippet(notes_fts, 1, '<mark>', '</mark>', '...', 32) as snippet,
           rank
    FROM notes_fts
    JOIN notes n ON n.rowid = notes_fts.rowid
    WHERE notes_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(escaped, limit) as Array<{
    id: string;
    path: string;
    title: string;
    snippet: string;
    rank: number;
  }>;

  return rows.map(r => ({
    noteId: r.id,
    path: r.path,
    title: r.title,
    snippet: r.snippet,
    score: r.rank,
  }));
}

// ═══════════════════════════════════════════════════════════════════
// Edge Queries
// ═══════════════════════════════════════════════════════════════════

/**
 * Get all forward links (outgoing edges) from a note.
 * Returns raw edges — caller must filter through scope.
 */
export function getForwardLinks(db: Database, noteId: string): VaultEdge[] {
  const rows = db.prepare('SELECT * FROM edges WHERE source_id = ?').all(noteId);
  return rows.map(edgeRowToEdge);
}

/**
 * Get all backlinks (incoming edges) to a note.
 * Returns raw edges — caller must filter through scope.
 */
export function getBacklinks(db: Database, noteId: string): Array<VaultEdge & { sourceTitle: string; sourcePath: string }> {
  const rows = db.prepare(`
    SELECT e.*, n.title as source_title, n.path as source_path
    FROM edges e
    JOIN notes n ON n.id = e.source_id
    WHERE e.target_id = ?
  `).all(noteId);

  return rows.map((r: any) => ({
    ...edgeRowToEdge(r),
    sourceTitle: r.source_title,
    sourcePath: r.source_path,
  }));
}

function edgeRowToEdge(row: any): VaultEdge {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    rawLink: row.raw_link,
    targetPath: row.target_path,
    linkType: row.link_type,
    fragmentType: row.fragment_type,
    fragmentId: row.fragment_id,
    sourceOffset: row.source_offset,
    displayText: row.display_text,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Index Status
// ═══════════════════════════════════════════════════════════════════

export function getIndexStatus(db: Database, project: string): VaultIndexStatus {
  const noteCount = (db.prepare('SELECT COUNT(*) as c FROM notes').get() as { c: number }).c;
  const edgeCount = (db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;
  const attachmentCount = (db.prepare('SELECT COUNT(*) as c FROM attachments').get() as { c: number }).c;
  const scopeCount = (db.prepare('SELECT COUNT(*) as c FROM scopes').get() as { c: number }).c;
  const totalSize = (db.prepare('SELECT COALESCE(SUM(size_bytes), 0) as s FROM notes').get() as { s: number }).s;
  const lastRebuild = (db.prepare('SELECT MAX(indexed_at) as t FROM notes').get() as { t: number | null }).t;

  return {
    project,
    initialized: noteCount > 0,
    noteCount,
    edgeCount,
    attachmentCount,
    scopeCount,
    totalSizeBytes: totalSize,
    lastRebuildAt: lastRebuild,
    staleNotes: 0, // TODO: compare indexed_at vs mtime
  };
}

// ═══════════════════════════════════════════════════════════════════
// Note Deletion
// ═══════════════════════════════════════════════════════════════════

/**
 * Remove a note from the index. CASCADE handles edges, headings, blocks, scope_membership.
 */
export function deleteNoteFromIndex(db: Database, noteId: string): boolean {
  const result = db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
  return result.changes > 0;
}

// ═══════════════════════════════════════════════════════════════════
// Heading / Block Queries
// ═══════════════════════════════════════════════════════════════════

export function getHeadings(db: Database, noteId: string): VaultHeading[] {
  return db.prepare('SELECT level, text, slug, offset FROM headings WHERE note_id = ? ORDER BY offset').all(noteId) as VaultHeading[];
}

export function getBlocks(db: Database, noteId: string): VaultBlock[] {
  return db.prepare('SELECT block_id as "blockId", offset, preview FROM blocks WHERE note_id = ? ORDER BY offset').all(noteId) as VaultBlock[];
}
