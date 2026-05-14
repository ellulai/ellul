// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Scoped Knowledge Vault types. Edges are raw; visible backlinks/graph are resolved per-principal.

import crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════════
// Note Identity
// ═══════════════════════════════════════════════════════════════════

// sha256(project:path)[0:16]. Stable across rebuilds; changes on rename (aliases carry old links).
export function computeNoteId(project: string, relativePath: string): string {
  return crypto.createHash('sha256')
    .update(`${project}:${relativePath}`)
    .digest('hex')
    .slice(0, 16);
}

// ═══════════════════════════════════════════════════════════════════
// Core Vault Types
// ═══════════════════════════════════════════════════════════════════

export interface VaultNote {
  /** Deterministic: sha256(project:path)[0:16] — stable across index rebuilds */
  id: string;
  /** Project this note belongs to */
  project: string;
  /** Relative path from vault root (e.g., "notes/architecture.md") */
  path: string;
  /** Extracted title: first H1, or filename without extension */
  title: string;
  /** Parsed YAML frontmatter */
  frontmatter: Record<string, unknown> | null;
  /** All tags (frontmatter + inline #tags), including nested (e.g., #project/backend) */
  tags: string[];
  /** Alternative names from frontmatter aliases (resolve [[alias]] → this note) */
  aliases: string[];
  /** Word count of markdown body (excluding frontmatter) */
  wordCount: number;
  /** File size in bytes */
  sizeBytes: number;
  /** File creation time (Unix ms) */
  createdAt: number;
  /** File modification time (Unix ms) */
  modifiedAt: number;
}

export interface VaultHeading {
  /** Heading level 1-6 */
  level: number;
  /** Raw heading text */
  text: string;
  /** Slugified text for #heading link resolution */
  slug: string;
  /** Character offset in source file */
  offset: number;
}

export interface VaultBlock {
  /** Block ID (the ^identifier part) */
  blockId: string;
  /** Character offset in source file */
  offset: number;
  /** First ~200 chars of the block content */
  preview: string;
}

// ═══════════════════════════════════════════════════════════════════
// Edge / Link Types
// ═══════════════════════════════════════════════════════════════════

export type LinkType = 'wikilink' | 'embed' | 'markdown_link';
export type FragmentType = 'heading' | 'block';

export interface VaultEdge {
  id: number;
  /** Note ID of the source (where the link is written) */
  sourceId: string;
  /** Note ID of the target (NULL if unresolved) */
  targetId: string | null;
  /** Raw link text as written in the source: "target", "target#heading", etc. */
  rawLink: string;
  /** Resolved target path (NULL if unresolved) */
  targetPath: string | null;
  /** Link type */
  linkType: LinkType;
  /** Fragment type (heading or block) or null for whole-note links */
  fragmentType: FragmentType | null;
  /** Fragment identifier (heading slug or block ID) */
  fragmentId: string | null;
  /** Character offset in source file */
  sourceOffset: number;
  /** Display text from [[target|alias]] */
  displayText: string | null;
}

export interface BacklinkEntry {
  /** Note ID of the source that links here */
  sourceNoteId: string;
  /** Path of the source note */
  sourcePath: string;
  /** Title of the source note */
  sourceTitle: string;
  /** Surrounding text context snippet */
  context: string;
  /** Line number in source file */
  lineNumber: number;
}

// ═══════════════════════════════════════════════════════════════════
// Scope / Projection Types
// ═══════════════════════════════════════════════════════════════════

export interface ScopeRuleSet {
  /** Default action when no rule matches */
  default: 'include' | 'exclude';
  /** Rules evaluated top-to-bottom; last matching rule wins */
  rules: ScopeRule[];
  // true → out-of-scope targets show as phantom nodes with quantized counts. Agent-only.
  boundary_disclosure: boolean;
}

export type ScopeRule =
  | { type: 'folder_glob'; pattern: string; action: 'include' | 'exclude' }
  | { type: 'tag'; tag: string; action: 'include' | 'exclude' }
  | { type: 'frontmatter'; key: string; value?: string; op: 'eq' | 'neq' | 'exists'; action: 'include' | 'exclude' }
  | { type: 'note_path'; path: string; action: 'include' | 'exclude' };

export interface VaultScope {
  id: number;
  /** Unique name within the vault */
  name: string;
  /** Human-readable description */
  description: string | null;
  /** Scope rules */
  rules: ScopeRuleSet;
  /** Whether this is the default scope for agent access */
  isAgentDefault: boolean;
  /** Monotonic version counter — incremented on every rule change */
  version: number;
  createdAt: number;
  updatedAt: number;
}

// ═══════════════════════════════════════════════════════════════════
// Graph Types
// ═══════════════════════════════════════════════════════════════════

export type NodeVisibility = 'visible' | 'restricted' | 'phantom' | 'hidden';

export interface GraphNode {
  id: string;
  title: string;
  path: string;
  tags: string[];
  /** Node visibility in the scoped graph view */
  visibility: NodeVisibility;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: LinkType;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Count of hidden nodes (not visible to this principal) */
  restrictedCount: number;
  /** Whether the response was truncated due to node limit */
  truncated: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// Search Types
// ═══════════════════════════════════════════════════════════════════

export interface SearchResult {
  noteId: string;
  path: string;
  title: string;
  /** FTS5 highlighted snippet */
  snippet: string;
  /** Relevance score (lower = more relevant in FTS5) */
  score: number;
}

// ═══════════════════════════════════════════════════════════════════
// Share Link / Capability Token Types
// ═══════════════════════════════════════════════════════════════════

export type SharingPolicy = 'internal' | 'external';

export interface ShareLink {
  id: number;
  token: string;
  noteId: string;
  fragmentType: FragmentType | null;
  fragmentId: string | null;
  createdBy: string;
  sharingPolicy: SharingPolicy;
  maxUses: number | null;
  useCount: number;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

export type PrincipalType = 'human' | 'agent';

export interface CapabilityToken {
  id: number;
  token: string;
  noteId: string;
  fragmentType: FragmentType | null;
  fragmentId: string | null;
  scopeId: number | null;
  sessionId: string;
  vaultSessionId: string | null;
  principalType: PrincipalType;
  maxUses: number;
  useCount: number;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

// ═══════════════════════════════════════════════════════════════════
// Vault Session Types (agent scope binding)
// ═══════════════════════════════════════════════════════════════════

export interface VaultSession {
  id: string;
  /** Shield session ID this vault session is bound to */
  sessionId: string;
  project: string;
  /** Scope ID (referential integrity) */
  scopeId: number;
  /** Scope name (denormalized for audit readability) */
  scopeName: string;
  /** HMAC key for generating opaque phantom node IDs */
  phantomKey: string;
  /** Projection version at creation time */
  projectionVersion: number;
  createdAt: number;
  expiresAt: number;
}

// ═══════════════════════════════════════════════════════════════════
// Attachment Types
// ═══════════════════════════════════════════════════════════════════

/** MIME types allowed for vault attachments. Executables are rejected. */
export const ALLOWED_ATTACHMENT_MIMES: ReadonlySet<string> = new Set([
  // Images
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'image/avif', 'image/bmp', 'image/tiff', 'image/x-icon',
  // Documents
  'application/pdf',
  // Audio
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/aac', 'audio/flac',
  // Video
  'video/mp4', 'video/webm', 'video/ogg',
  // Fonts
  'font/woff', 'font/woff2', 'font/ttf', 'font/otf',
  // Data
  'application/json', 'text/csv', 'text/plain',
]);

export interface VaultAttachment {
  id: number;
  path: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string;
  indexedAt: number;
}

// ═══════════════════════════════════════════════════════════════════
// Index Status
// ═══════════════════════════════════════════════════════════════════

export interface VaultIndexStatus {
  project: string;
  initialized: boolean;
  noteCount: number;
  edgeCount: number;
  attachmentCount: number;
  scopeCount: number;
  totalSizeBytes: number;
  lastRebuildAt: number | null;
  staleNotes: number;
}

// ═══════════════════════════════════════════════════════════════════
// Audit Event Types
// ═══════════════════════════════════════════════════════════════════

export type VaultAuditEvent =
  | 'vault.note.read'
  | 'vault.note.create'
  | 'vault.note.update'
  | 'vault.note.delete'
  | 'vault.note.rename'
  | 'vault.note.list'
  | 'vault.note.read_denied'
  | 'vault.search.query'
  | 'vault.search.query_denied'
  | 'vault.graph.expand'
  | 'vault.graph.expand_denied'
  | 'vault.backlinks.read'
  | 'vault.scope.create'
  | 'vault.scope.update'
  | 'vault.scope.delete'
  | 'vault.capability.request'
  | 'vault.capability.resolve'
  | 'vault.capability.resolve_denied'
  | 'vault.capability.revoke'
  | 'vault.share_link.create'
  | 'vault.share_link.resolve'
  | 'vault.share_link.revoke'
  | 'vault.attachment.read'
  | 'vault.attachment.read_denied'
  | 'vault.import'
  | 'vault.index.rebuild'
  | 'vault.session.create'
  | 'vault.session.invalidate';

// ═══════════════════════════════════════════════════════════════════
// Backlink Count Clamping (Anti-Side-Channel)
// ═══════════════════════════════════════════════════════════════════

export type ClampedCount = 'none' | 'some' | 'several' | 'many';

/**
 * Quantize a restricted backlink count into a coarse bucket.
 * Prevents agents from detecting individual note creation/deletion
 * by monitoring count changes.
 *
 * | Actual | Agent sees |
 * |--------|-----------|
 * | 0      | "none"    |
 * | 1-3    | "some"    |
 * | 4-10   | "several" |
 * | 11+    | "many"    |
 */
export function clampBacklinkCount(count: number): ClampedCount {
  if (count <= 0) return 'none';
  if (count <= 3) return 'some';
  if (count <= 10) return 'several';
  return 'many';
}

// ═══════════════════════════════════════════════════════════════════
// Rate Limit / Budget Constants
// ═══════════════════════════════════════════════════════════════════

export const VAULT_RATE_LIMITS = {
  owner: {
    noteReads: 200,
    searchQueries: 60,
    graphExpansions: 100,
    backlinkQueries: 100,
    indexRebuilds: 2,
    imports: 1,
    shareLinkCreation: 20,
    capabilityRequests: 10,
  },
  collaborator: {
    noteReads: 100,
    searchQueries: 30,
    graphExpansions: 50,
    backlinkQueries: 50,
  },
  agent: {
    noteReads: 60,
    searchQueries: 20,
    graphExpansions: 30,
    backlinkQueries: 30,
    capabilityRequests: 5,
    /** Per-session total graph expansion budget */
    graphExpansionBudget: 50,
  },
} as const;

// ═══════════════════════════════════════════════════════════════════
// Vault Configuration Constants
// ═══════════════════════════════════════════════════════════════════

/** Directory containing per-project vault index databases */
export const VAULT_INDEX_DIR = '/etc/ellul/shield-data/vault-idx';

/** Default TTL for vault_read gate (4 hours, same as exec) */
export const VAULT_READ_DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;

/** Debounce interval for filesystem watcher re-indexing */
export const VAULT_WATCHER_DEBOUNCE_MS = 500;

/** Maximum notes returned in a single graph query */
export const VAULT_GRAPH_NODE_LIMIT = 500;

/** Default graph neighborhood depth */
export const VAULT_GRAPH_DEFAULT_DEPTH = 2;

/** Maximum file size for vault notes */
export const VAULT_MAX_NOTE_SIZE = 5 * 1024 * 1024;

/** Maximum file size for vault attachments */
export const VAULT_MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024;

/** Maximum number of notes per vault */
export const VAULT_MAX_NOTES = 50_000;

/** Files/dirs stripped during Obsidian import */
export const VAULT_IMPORT_STRIP_PATTERNS = [
  '.obsidian',
  '.DS_Store',
  '.git',
  '.trash',
  'Thumbs.db',
] as const;

/** Patterns that identify dotfiles/hidden files to skip during import */
export const VAULT_IMPORT_SKIP_DOTFILES = /^\./;

/** File extensions recognized as markdown notes */
export const VAULT_NOTE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.markdown',
]);

/** File extensions recognized as canvas files */
export const VAULT_CANVAS_EXTENSIONS: ReadonlySet<string> = new Set([
  '.canvas',
]);

// ═══════════════════════════════════════════════════════════════════
// Markdown Parsing Types
// ═══════════════════════════════════════════════════════════════════

/** Result of parsing a single markdown file */
export interface ParsedNote {
  title: string;
  frontmatter: Record<string, unknown> | null;
  tags: string[];
  aliases: string[];
  headings: VaultHeading[];
  blocks: VaultBlock[];
  links: ParsedLink[];
  wordCount: number;
}

export interface ParsedLink {
  /** Raw link text: "Note Name", "Note Name#Heading", "Note Name#^block" */
  rawLink: string;
  /** Link type */
  linkType: LinkType;
  /** Fragment type */
  fragmentType: FragmentType | null;
  /** Fragment identifier */
  fragmentId: string | null;
  /** Character offset in source */
  offset: number;
  /** Display text from [[target|alias]] */
  displayText: string | null;
}
