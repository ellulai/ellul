# Scoped Knowledge Vault — Architecture & Implementation

## Context

ellul.ai is a zero-trust AI agent execution platform. Agents are treated as hostile — they get scoped projections, not raw access. The Scoped Knowledge Vault adds an Obsidian-like knowledge layer (vault, wiki-links, graph, backlinks) with **policy-aware scoping**: a visible note must NOT create a privilege escalation path into the rest of the vault. Backlinks, graph neighbors, search results, and deep links are all server-side scoped. Agents get stricter defaults than humans.

No existing open-source tool should be trusted as the policy boundary for Obsidian-style link resolution and scoped graph access. We may reuse parsers or rendering components, but authorization, scope projection, and governed traversal must be implemented natively in ellul.ai. We reuse the existing gate system, cross-project access patterns, SQLite infrastructure, and namespace isolation.

### Relationship to gbrain

gbrain ([17-gbrain-scrub-layer.md](./17-gbrain-scrub-layer.md), [runtime/11-gbrain.md](../runtime/11-gbrain.md)) serves as the MCP-accessible knowledge backend — it stores, indexes, and retrieves knowledge via Postgres + pgvector. The Scoped Knowledge Vault is the policy-governed projection layer — it controls what agents can see based on project scope. They complement each other: gbrain handles persistence and retrieval, the vault handles authorization and scoping.

---

## 1. Current Architecture (Relevant Primitives)

| Primitive | Location | Reuse For Vault |
|-----------|----------|-----------------|
| **Gate system** | `sovereign-shield/src/services/gate.service.ts` — typed gates, TTL, scopes (once/session/timed), permissions (ask/allow_session/allow_always/never) | Add `vault_read` gate type |
| **Gate permissions** | `gate-permissions.service.ts` — `GateType` union, `VALID_GATE_TYPES` set, feature-flag extension pattern (`wallet_spend`) | Extend with `vault_read` using same pattern |
| **STS tokens** | `sts.service.ts` — project-scoped JWT (HS256, 15-min, session-bound), provides `stsProject` | Vault access bound to project via STS |
| **IPC tokens** | `internal-token.service.ts` — per-service HMAC tokens, 30-min rotation, ACL enforcement | Agent-bridge calls vault internal endpoints |
| **ACL policy** | `internal-auth.middleware.ts` — default-deny endpoint ACL per service identity | Add vault entries for agent-bridge |
| **Cross-project access** | `cross-project.service.ts` — DB + JSON config → rsync snapshots, browser-session-authorized | Pattern for scope rules storage + sync |
| **Audit log** | `audit.service.ts` — tamper-evident hash chain in SQLite | Vault access audit events |
| **File API** | `file-api/src/files.service.ts` — TOCTOU-proof fd-based reads, path traversal prevention | Vault note reads delegate here OR reuse pattern |
| **Agent bridge** | `agent-bridge/src/main.ts` — WebSocket protocol, namespace spawn, shield IPC client | Agent vault queries proxied through bridge |
| **SQLite WAL** | `database.ts` — better-sqlite3, WAL mode, 600 perms, prepared statements | Vault index DB uses same pattern |
| **Route registration** | `routes/index.ts` — `registerAllRoutes()`, `registerXyzRoutes(app)` pattern | Add `registerVaultRoutes(app)` |
| **Dashboard nav** | `useDashboardNav.ts` — `APP_CONTEXTS` array, tab configs per context | Add `"vault"` context |
| **Realtime** | `realtime-provider.tsx` — WebSocket message types, React Query invalidation | Add `vault_index_changed` event |
| **React Query** | `query-provider.tsx` — staleTime 60s, gcTime 5m | Vault query keys follow same config |

---

## 2. Gap Analysis

| Need | Current State | Gap |
|------|--------------|-----|
| Markdown parsing (wiki-links, frontmatter, headings, blocks) | None | **Build**: parser module in shield |
| FTS5 full-text search | None | **Build**: SQLite FTS5 index per vault |
| Graph data structure | None | **Build**: edges table + scoped projection |
| Scope/projection engine | Cross-project has include/exclude patterns | **Extend**: generalize to folder/tag/frontmatter rules |
| Backlink computation | None | **Build**: inverse edge lookup with scope filtering |
| Deep link capabilities | Preview tokens exist (similar concept) | **Build**: capability tokens with scope binding |
| Obsidian markdown renderer | `react-markdown` + `remark-gfm` installed | **Extend**: add wiki-link, callout, embed plugins |
| Graph visualization | No graph libs installed | **Add**: `@react-force-graph/2d` |
| Vault note editor | Code browser exists (read-only) | **Build**: note editor with markdown preview |

---

## 3. Target Architecture

```
                    ┌─────────────────────────────────────┐
                    │        Console (Next.js)             │
                    │  ┌─────────┐ ┌───────┐ ┌─────────┐ │
                    │  │VaultTree│ │NoteView│ │GraphView│ │
                    │  └────┬────┘ └───┬───┘ └────┬────┘ │
                    │       └──────────┼──────────┘       │
                    └──────────────────┼──────────────────┘
                                       │ HTTPS (session auth)
                    ┌──────────────────┼──────────────────┐
                    │          Sovereign Shield            │
                    │  ┌────────────────────────────────┐  │
                    │  │     vault.routes.ts             │  │
                    │  │  /_auth/vault/* (browser)       │  │
                    │  │  /api/internal/vault/* (IPC)    │  │
                    │  └────────────┬───────────────────┘  │
                    │               │                      │
                    │  ┌────────────┴───────────────────┐  │
                    │  │  vault-index.service.ts         │  │
                    │  │  - md parser (frontmatter,      │  │
                    │  │    headings, blocks, wiki-links) │  │
                    │  │  - FTS5 index maintenance       │  │
                    │  │  - fswatch debounced re-index   │  │
                    │  └────────────┬───────────────────┘  │
                    │               │                      │
                    │  ┌────────────┴───────────────────┐  │
                    │  │  vault-scope.service.ts         │  │
                    │  │  - scope rule evaluation        │  │
                    │  │  - membership materialization   │  │
                    │  │  - phantom node HMAC            │  │
                    │  │  - backlink count clamping      │  │
                    │  └────────────────────────────────┘  │
                    └──────────────────────────────────────┘
                         │ reads                │ IPC
              ┌──────────┴──────┐    ┌─────────┴──────────┐
              │  Vault files    │    │   Agent Bridge      │
              │  ~/projects/    │    │   (WebSocket)       │
              │  <proj>/        │    │   vault_search,     │
              │  (vault root    │    │   vault_get_note,   │
              │   = project dir │    │   vault_backlinks,  │
              │   or configured)│    │   vault_graph       │
              └─────────────────┘    │                     │
                                     └────────┬───────────┘
              ┌─────────────────┐              │
              │ Vault Index DB  │    ┌─────────┴───────────┐
              │ shield-data/    │    │   Agent (namespace)  │
              │ vault-idx/      │    │   Sees vault via     │
              │ <proj>.db       │    │   bridge proxy only  │
              └─────────────────┘    └─────────────────────┘
```

### Trust Zones

- **Privileged human** (vault owner/admin): Full vault visibility if role permits, scope management
- **Standard human** (collaborator): Role-scoped access — sees policy-resolved subset of vault, not raw full graph
- **Shield** (auth boundary): Owns index DB, enforces scopes for ALL principals (human and agent), mediates all access
- **Agent** (untrusted): Strictest projection-scoped access via bridge→shield IPC. Cannot read index DB, vault files, or scope rules directly. Restricted edge disclosure is OFF by default.

Browser access is role-bound. Human access is broader than agent access by default, but not inherently unrestricted.

### Key Decisions

1. Vault content lives in a designated workspace content area — NOT forced into a `.vault/` subdirectory. Imported Obsidian vaults preserve their relative structure unless an import policy explicitly normalizes paths. ellul-specific metadata (index, scopes) lives in shield-data outside the vault root. This avoids collisions with existing tooling, gitignore, and backup/migration flows.
2. Index DB lives in shield-data (`/etc/ellul/shield-data/vault-idx/<project>.db`) — agent cannot access
3. Vault service is a module within sovereign-shield (not a separate service) — scope enforcement IS auth
4. Agent accesses vault via agent-bridge WebSocket → shield IPC (not MCP, not direct file read)
5. Files on disk are source of truth; index is derived and rebuildable
6. **Edges are raw parsed relationships, NOT authorized views.** Visible backlinks and graph edges are resolved views computed per-request per-principal. No consumer should ever treat raw edges as UI-ready data.
7. **Graph traversal is always executed against the principal-resolved scoped graph view, never against the raw edges table directly.** Every graph query — neighborhood expansion, backlink lookup, full graph render — runs through the scope engine first. The raw edges table is an internal indexing structure, not a queryable API surface.

---

## 4. Data Model

### 4.1 Vault Index SQLite (per-project, in shield-data)

Path: `/etc/ellul/shield-data/vault-idx/<project-slug>.db`

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

-- ── Notes (derived from vault root markdown files) ──
-- Note IDs must be stable across index rebuilds because they appear in:
-- audit logs, cached UI state (React Query keys), share links, capability tokens.
-- We use a deterministic ID derived from the vault-scoped path:
--   id = hex(SHA-256(project_slug + ":" + relative_path))[0:16]
-- This is stable across rebuilds, unique within a vault, and changes on rename
-- (which is correct — rename creates a new logical identity, old links use aliases).
CREATE TABLE notes (
  id           TEXT PRIMARY KEY,          -- deterministic: sha256(project:path)[0:16]
  path         TEXT NOT NULL UNIQUE,      -- relative to vault root
  title        TEXT NOT NULL,             -- first H1 or filename
  content_hash TEXT NOT NULL,             -- SHA-256 (change detection)
  frontmatter  TEXT,                      -- JSON (parsed YAML)
  tags         TEXT,                      -- JSON array
  aliases      TEXT,                      -- JSON array (from frontmatter)
  word_count   INTEGER NOT NULL DEFAULT 0,
  size_bytes   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  modified_at  INTEGER NOT NULL,
  indexed_at   INTEGER NOT NULL
);

-- ── Full-Text Search ──
-- NOTE: Tokenizer is an initial choice, subject to language/search-quality review.
-- Abstracted behind index rebuild so tokenizer strategy can evolve without migration.
-- Porter stemming may produce odd results for non-English or wiki-link-heavy text.
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, content, tags,
  content=notes, content_rowid=id,
  tokenize='unicode61'  -- no stemmer initially; add porter later if search quality demands it
);

-- ── Headings (for [[note#heading]] resolution) ──
CREATE TABLE headings (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  level   INTEGER NOT NULL,
  text    TEXT NOT NULL,
  slug    TEXT NOT NULL,
  offset  INTEGER NOT NULL
);
CREATE INDEX idx_headings_note_slug ON headings(note_id, slug);

-- ── Block References (for [[note#^block-id]]) ──
CREATE TABLE blocks (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  offset   INTEGER NOT NULL,
  preview  TEXT
);
CREATE UNIQUE INDEX idx_blocks_note_block ON blocks(note_id, block_id);

-- ── Edges (wiki-links + embeds — RAW parsed relationships, not authorized views) ──
CREATE TABLE edges (
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
CREATE INDEX idx_edges_source ON edges(source_id);
CREATE INDEX idx_edges_target ON edges(target_id);

-- ── Scopes (named projections) ──
CREATE TABLE scopes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE,
  description      TEXT,
  rules            TEXT NOT NULL,          -- JSON: ScopeRuleSet
  is_agent_default INTEGER NOT NULL DEFAULT 0,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- ── Materialized Scope Membership ──
-- Scope membership is materialized at the scope level; principal-specific
-- restrictions are applied at query resolution time, not by duplicating
-- membership per principal.
CREATE TABLE scope_membership (
  scope_id INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  PRIMARY KEY (scope_id, note_id)
);

-- ── Attachments (images, PDFs, etc. embedded in notes) ──
CREATE TABLE attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL UNIQUE,       -- relative to configured vault root
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at  INTEGER NOT NULL
);
-- Attachment visibility is derived from authorized reference paths.
-- Attachments do NOT participate in the graph as nodes.

-- ── Share Links (human UX navigation — durable, shareable) ──
CREATE TABLE share_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token         TEXT NOT NULL UNIQUE,     -- 32-byte random hex
  note_id       TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  fragment_type TEXT,
  fragment_id   TEXT,
  created_by    TEXT NOT NULL,            -- credential_id of human creator
  sharing_policy TEXT NOT NULL DEFAULT 'internal', -- 'internal' | 'external'
  max_uses      INTEGER,
  use_count     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  revoked_at    INTEGER
);

-- ── Capability Tokens (security-bearing access artifacts — session-bound) ──
-- NOT general share primitives. Strictly for: session-bound internal navigation,
-- approved agent follow-ups, and narrow privileged workflows.
CREATE TABLE capability_tokens (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  token           TEXT NOT NULL UNIQUE,   -- 32-byte random hex
  note_id         TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  fragment_type   TEXT,
  fragment_id     TEXT,
  scope_id        INTEGER REFERENCES scopes(id) ON DELETE SET NULL,
  session_id      TEXT NOT NULL,          -- bound to issuing session
  vault_session_id TEXT,                  -- bound to vault session (agent only)
  principal_type  TEXT NOT NULL,          -- 'human' | 'agent'
  max_uses        INTEGER NOT NULL DEFAULT 1,
  use_count       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);

-- ── Vault Sessions (agent scope binding) ──
CREATE TABLE vault_sessions (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,           -- shield session binding
  project        TEXT NOT NULL,
  scope_id       INTEGER NOT NULL,        -- FK to scopes(id) — use ID for referential integrity
  scope_name     TEXT NOT NULL,           -- denormalized for audit readability
  phantom_key    TEXT NOT NULL,           -- HMAC key for opaque boundary node IDs
  projection_ver INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);
```

### 4.2 Platform PostgreSQL (console registry only)

Add to `packages/db/src/schema.ts`:

```typescript
export const vaults = pgTable('vaults', {
  id: text('id').primaryKey(),
  serverId: text('server_id').notNull().references(() => servers.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  project: text('project').notNull(),
  noteCount: integer('note_count').notNull().default(0),
  edgeCount: integer('edge_count').notNull().default(0),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  serverProjectIdx: uniqueIndex('vaults_server_project_idx').on(t.serverId, t.project),
}));
```

---

## 5. Permission Model

### 5.1 Gate Integration

Add `vault_read` to the existing gate system:

```typescript
export type GateType = 'logs' | 'env' | 'db_read' | 'db_write' | 'db_migrate'
                      | 'git' | 'deploy' | 'exec' | 'wallet_spend' | 'vault_read';
```

Add to `VALID_GATE_TYPES`. Default TTL: 4 hours (same as `exec`). The gate controls **whether** the agent can access the vault. The scope controls **what** the agent sees.

### 5.2 Three-Tier Permission Matrix

Three principal tiers: **Owner/Admin** (vault owner or project admin), **Collaborator** (human with role-scoped access), **Agent** (bridge-authenticated, vault_read gate).

| Operation | Owner/Admin | Collaborator (human, role-scoped) | Agent (vault_read gate) | Agent (no gate) |
|-----------|-------------|-----------------------------------|-------------------------|-----------------|
| Read note content | All notes | Role-scoped notes | Projection-scoped notes | DENY |
| List notes | All notes | Role-scoped | Projection-scoped | DENY |
| See note title | All notes | Role-scoped + restricted count | Projection-scoped only | DENY |
| See note preview | All notes | Role-scoped | Projection-scoped only | DENY |
| See backlink exists | Full count | Policy-configurable: indicator/bucket by default, exact count for higher-trust roles | Clamped bucket (see 5.4) | DENY |
| Follow backlink | All | Role-scoped sources | Projection-scoped sources | DENY |
| See graph node | All | Role-scoped + restricted indicators | Projection-scoped only (**no phantoms by default**) | DENY |
| Expand graph neighbors | All | Role-scoped neighbors | Projection-scoped only | DENY |
| Full-text search | All notes | Role-scoped (no count leak) | Projection-scoped (no count leak) | DENY |
| Create share link | Subject to sharing policy | Subject to sharing policy | DENY | DENY |
| Create capability token | Internal, policy-checked | DENY | Queued for human approval | DENY |
| Resolve share/capability | Always | Valid + role allows | Valid + not revoked + session-bound | DENY |
| Export | Policy-checked | DENY | DENY | DENY |
| Manage scopes | Full CRUD | DENY | DENY | DENY |

**Critical default: Agents do NOT see phantom/boundary nodes.**

Restricted edge disclosure is OFF by default for agents. The agent sees only in-scope nodes and edges between them. Out-of-scope targets are fully hidden — no phantom, no ghost, no count. This prevents leaking:
- Hidden adjacency / graph density
- Hidden document structure
- Sensitive workflow shape (e.g., many phantom neighbors reveals something important exists nearby)

Optional elevated mode (`boundary_disclosure: true` on scope definition) enables phantom nodes with quantized counts for specific workflows where the agent benefits from knowing "more context exists." This must be explicitly opted in per scope by the human.

Collaborator (human) mode may see restricted indicators ("N restricted notes link here") depending on role.

### 5.3 Scope Rule Schema

```typescript
interface ScopeRuleSet {
  default: 'include' | 'exclude';  // if no rule matches
  rules: ScopeRule[];              // evaluated top-to-bottom, last match wins
  
  // Boundary disclosure: if true, out-of-scope link targets appear as
  // phantom nodes with quantized backlink counts. Default: false.
  // Only relevant for agent scopes. Human scopes may show restricted indicators
  // based on role regardless of this setting.
  boundary_disclosure: boolean;
}

type ScopeRule =
  | { type: 'folder_glob'; pattern: string; action: 'include' | 'exclude' }
  | { type: 'tag'; tag: string; action: 'include' | 'exclude' }
  | { type: 'frontmatter'; key: string; value?: string; op: 'eq' | 'neq' | 'exists'; action: 'include' | 'exclude' }
  | { type: 'note_path'; path: string; action: 'include' | 'exclude' };
```

### 5.4 Backlink Count Clamping (Anti-Side-Channel)

| Actual restricted count | Agent sees |
|------------------------|------------|
| 0 | "no restricted backlinks" |
| 1-3 | "some" |
| 4-10 | "several" |
| 11+ | "many" |

Counts are fixed at vault session creation time — they do NOT update mid-session. This prevents the agent from detecting note creation/deletion by watching count changes.

### 5.5 Boundary Edge Handling

When Note A is in scope and links to Note B which is NOT in scope:

**Default agent mode (`boundary_disclosure: false`):**
- Edge is fully hidden. Agent sees Note A but does NOT see the link to Note B.
- Agent cannot detect that Note A links to anything outside its scope.
- This is the safest baseline.

**Elevated agent mode (`boundary_disclosure: true`, explicit opt-in per scope):**
- Agent sees the edge exists
- Target is replaced with opaque ID: `HMAC-SHA256(session_phantom_key, note_path)` truncated to 16 hex
- Phantom exposes: nothing (no title, path, tags, content)
- Phantom is **terminal**: expanding it returns zero neighbors
- IDs are per-session (not stable across sessions — prevents cross-session correlation)

**Collaborator (human) mode:**
- May see restricted indicators ("N restricted notes link here") based on role
- May see phantom-style boundary nodes in graph view if role permits
- Never sees content/path of out-of-scope notes

---

## 6. API Design

### 6.1 Browser-Facing Routes (session auth via tier-gate)

New file: `sovereign-shield/src/routes/vault.routes.ts`
Prefix: `/_auth/vault/`

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/_auth/vault/init` | Initialize vault for a project |
| `GET` | `/_auth/vault/notes` | List notes (`?project=&path=&q=`) |
| `GET` | `/_auth/vault/notes/:noteId` | Get note + content + backlinks + forward links |
| `POST` | `/_auth/vault/notes` | Create note |
| `PUT` | `/_auth/vault/notes/:noteId` | Update note content |
| `DELETE` | `/_auth/vault/notes/:noteId` | Delete note |
| `POST` | `/_auth/vault/import` | Import Obsidian export (zip). Preserves relative folder structure, attachments, frontmatter. Stripped/skipped: `.obsidian/` config, dotfiles (`.DS_Store`, `.git/`, etc.), symlinks (rejected — prevents symlink-to-secret attacks), executable files, unsupported binary formats (only allowlisted MIME types: images, PDFs, audio, video, fonts). Triggers full index rebuild. |
| `GET` | `/_auth/vault/search` | Full-text search (`?project=&q=&limit=`) |
| `GET` | `/_auth/vault/graph` | Full/scoped graph (`?project=&scope=&center=&depth=`) |
| `GET` | `/_auth/vault/backlinks/:noteId` | Backlinks for a note (`?project=&scope=`) |
| `POST` | `/_auth/vault/scopes` | Create scope |
| `GET` | `/_auth/vault/scopes` | List scopes (`?project=`) |
| `PUT` | `/_auth/vault/scopes/:scopeId` | Update scope rules |
| `DELETE` | `/_auth/vault/scopes/:scopeId` | Delete scope |
| `POST` | `/_auth/vault/share-links` | Create share link (policy-checked) |
| `GET` | `/_auth/vault/share-links/:token` | Resolve share link |
| `DELETE` | `/_auth/vault/share-links/:token` | Revoke share link |
| `POST` | `/_auth/vault/capabilities` | Create capability token (policy-checked, session-bound internal navigation only) |
| `GET` | `/_auth/vault/capabilities/:token` | Resolve capability token |
| `POST` | `/_auth/vault/notes/:noteId/rename` | Rename/move note (with link retargeting) |
| `GET` | `/_auth/vault/attachments/:path` | Serve attachment (scope-checked) |
| `GET` | `/_auth/vault/index/status` | Index health (`?project=`) |
| `POST` | `/_auth/vault/index/rebuild` | Force re-index |

### 6.2 Internal Routes (IPC token auth, for agent-bridge)

New file: `sovereign-shield/src/routes/vault-internal.routes.ts`
Prefix: `/api/internal/vault/`

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/internal/vault/notes` | Scoped note list (`?project=&scope=`) |
| `GET` | `/api/internal/vault/notes/:noteId` | Scoped note read |
| `GET` | `/api/internal/vault/search` | Scoped search |
| `GET` | `/api/internal/vault/graph` | Scoped graph (with phantoms if `boundary_disclosure` enabled) |
| `GET` | `/api/internal/vault/backlinks/:noteId` | Scoped backlinks with clamped counts |
| `POST` | `/api/internal/vault/capability-request` | Queue capability token for human approval |

ACL entry in `internal-auth.middleware.ts`:
```typescript
{ pattern: '/api/internal/vault/', allow: [BRIDGE] },
```

### 6.3 Agent Bridge WebSocket Messages

```
vault_search       → proxies to /api/internal/vault/search
vault_get_note     → proxies to /api/internal/vault/notes/:noteId
vault_backlinks    → proxies to /api/internal/vault/backlinks/:noteId
vault_graph        → proxies to /api/internal/vault/graph
vault_list_notes   → proxies to /api/internal/vault/notes
```

New service: `agent-bridge/src/services/vault-proxy.service.ts`

---

## 7. Rename/Move Semantics

**v1 behavior (explicit):**
- `POST /_auth/vault/notes/:noteId/rename` accepts `{ newPath: string }`
- Shield moves the file on disk, then:
  1. Updates the `notes.path` in the index
  2. Re-resolves all edges where `target_path` matched the old path → update to new path
  3. Does NOT rewrite wiki-link text in other files (deferred to v2)
  4. Adds an alias entry: old filename added to `aliases` in frontmatter (so old `[[links]]` still resolve). Alias insertion is best-effort — handles existing frontmatter, existing aliases array, and conflicting entries gracefully. Falls back safely if frontmatter is malformed or file is read-only.
- Rename does not affect heading/block resolution when note content is unchanged
- Block reference stability depends on block ID preservation in the source content — if the user edits the block ID, the reference breaks (same as Obsidian)
- Fragment references (`#heading`, `#^block`) survive rename as long as the referenced content is preserved

**v2 (future):**
- Auto-rewrite `[[old-name]]` → `[[new-name]]` in all referencing notes
- Batch operation with atomic index update

---

## 8. Cache Invalidation Matrix

| Change Event | Invalidate |
|-------------|------------|
| Note content modified | FTS row, heading/block tables, raw edges (re-parse links), scope membership (if frontmatter/tags changed), projection version, cached graph |
| Note renamed/moved | `notes.path`, edge `target_path` re-resolution, alias update, scope membership (if path rules affected), projection version |
| Note deleted | CASCADE: edges, headings, blocks, scope_membership, share_links, capability_tokens referencing note. Projection version bump. |
| Frontmatter changed | Tags, aliases, scope membership (if frontmatter rules exist), FTS tags column |
| Scope rules changed | Rebuild `scope_membership` for that scope, bump `scopes.version`, invalidate all vault sessions using that scope |
| Attachment added/removed | `attachments` table, embed edges if attachment was referenced |

All invalidation is handled by `vault-watcher.service.ts` (fswatch) → `vault-index.service.ts` (re-index) → scope membership rebuild → version bump. The watcher debounces at 500ms to batch rapid edits.

**Scope membership is materialized at the scope level; principal-specific restrictions are applied at query resolution time, not by duplicating membership per principal.**

---

## 9. Audit Event Taxonomy

| Event | Trigger |
|-------|---------|
| `vault.note.read` | Any principal reads note content |
| `vault.note.create` | Note created |
| `vault.note.update` | Note content modified |
| `vault.note.delete` | Note deleted |
| `vault.note.rename` | Note renamed/moved |
| `vault.note.list` | Note listing query |
| `vault.search.query` | Full-text search executed |
| `vault.graph.expand` | Graph neighborhood expansion |
| `vault.backlinks.read` | Backlinks query |
| `vault.scope.create` | Scope created |
| `vault.scope.update` | Scope rules modified |
| `vault.scope.delete` | Scope deleted |
| `vault.capability.request` | Agent requests capability token |
| `vault.capability.resolve` | Capability token resolved |
| `vault.capability.revoke` | Capability token revoked |
| `vault.share_link.create` | Share link created |
| `vault.share_link.resolve` | Share link resolved |
| `vault.share_link.revoke` | Share link revoked |
| `vault.attachment.read` | Attachment served |
| `vault.import` | Vault import executed |
| `vault.index.rebuild` | Manual index rebuild triggered |
| `vault.session.create` | Vault session created (agent) |
| `vault.session.invalidate` | Vault session invalidated (scope change) |
| `vault.note.read_denied` | Principal attempted to read out-of-scope note |
| `vault.graph.expand_denied` | Principal attempted to expand out-of-scope node or budget exhausted |
| `vault.attachment.read_denied` | Principal attempted to access out-of-scope attachment |
| `vault.capability.resolve_denied` | Capability token invalid, expired, or session mismatch |
| `vault.search.query_denied` | Search attempted without vault_read gate (agent) |

All events include: timestamp, principal type (owner/collaborator/agent), principal ID, project, scope (if applicable), IP, session ID. Appended to the existing tamper-evident audit hash chain.

---

## 10. Attachment Model

Attachments (images, PDFs, audio, etc.) embedded in notes via `![[image.png]]`:

- **Registry:** `attachments` table in vault index DB (path, MIME type, size, hash)
- **Storage:** Same directory structure as the user's vault (no forced reorganization)
- **Scoped access:** Attachment visibility is derived from authorized reference paths (embed/link edges from in-scope notes) and explicit attachment permissions. Unreferenced attachments default to hidden unless explicitly permitted.
- **Graph participation:** Attachments do NOT appear as graph nodes. They are embedded content, not knowledge entities.
- **Serving:** `GET /_auth/vault/attachments/:path` validates scope by checking if any in-scope note has an embed/link edge pointing to the attachment path, or if explicit attachment permissions grant access.
- **Agent access:** Attachments served via same scoped internal endpoint. MIME type whitelisting prevents serving executable content.

---

## 11. Rate Limiting / Query Budgets

| Operation | Owner/Admin | Collaborator | Agent |
|-----------|------------|--------------|-------|
| Note reads | 200/min | 100/min | 60/min |
| Search queries | 60/min | 30/min | 20/min |
| Graph expansions | 100/min | 50/min | 30/min (budget: 50/session total) |
| Backlink queries | 100/min | 50/min | 30/min |
| Index rebuild | 2/min | N/A | N/A |
| Import | 1/5min | N/A | N/A |
| Share link creation | 20/min | 10/min | N/A |
| Capability token request | 10/min | N/A | 5/min (requires human approval) |

Agent graph expansion has a **per-session budget** (default 50) in addition to rate limits. When budget is exhausted, further expansions return a clear bounded error status (`graph_expansion_budget_exhausted`) — not silent empty results. This is observable in logs and client behavior but does not reveal any information about the hidden graph.

Rate limiting reuses shield's existing `checkApiRateLimit` pattern.

---

## 12. Security Risks and Mitigations

| # | Risk | Attack Vector | Mitigation |
|---|------|---------------|------------|
| 1 | **Graph traversal enumeration** | Agent repeatedly expands boundary nodes to map hidden topology | **Default: no phantoms.** Boundary edges hidden entirely. When `boundary_disclosure` enabled: phantoms are terminal (zero neighbors), per-session opaque IDs prevent cross-session correlation, expansion budget per session (50 max), all expansions audit-logged. |
| 2 | **Backlink count side channel** | Agent monitors restricted count changes to detect note creation/deletion | Quantized buckets (0, 1-3, 4-10, 11+). Counts frozen at vault session creation — no mid-session updates. |
| 3 | **Search snippet leakage** | FTS5 returns content from out-of-scope notes | Results intersected with `scope_membership` BEFORE content returned. Out-of-scope matches are fully discarded — no count, no snippet, no indication. |
| 4 | **Capability token lateral movement** | Agent shares capability token with another agent/thread | Agent capability tokens: session-bound, max_uses=1, expires with vault session, requires human approval via gate SSE. Share links are a human UX/share primitive governed by explicit sharing policy and expiry rules; they are intentionally distinct from session-bound capability tokens. |
| 5 | **Stale projection after scope change** | Agent continues accessing revoked notes from cached projection | Version check on every request. Scope change invalidates all vault sessions using that scope. Gate auto-revoked if projection version changes. |
| 6 | **Title/metadata leakage via errors** | Agent guesses paths, error messages reveal existence | Uniform 404 for out-of-scope AND non-existent. No path reflection in errors. |
| 7 | **Index DB tampering** | Agent modifies index to include hidden notes | Index DB in shield-data (`/etc/ellul/shield-data/`) — agent has no filesystem access. Shield-runner owns the file (600 perms). |
| 8 | **Frontend overfetching** | Console requests full graph, filters client-side | All scope filtering is server-side. Owner gets full vault; collaborators get role-scoped response; agents get projection-scoped response. No client-side filtering for any principal. |
| 9 | **Cross-project graph bleed** | Vault in project A links to files in project B | Wiki-link resolution is vault-scoped (only resolves within the configured vault root for the project). Cross-vault links are treated as unresolved. |
| 10 | **Note path traversal** | `[[../../etc/passwd]]` as wiki-link | Same TOCTOU-proof path validation as file-api: resolve path, verify it starts with vault root. |
| 11 | **Raw HTML injection** | Imported notes contain malicious HTML | `rehype-raw` must be paired with `rehype-sanitize` using a strict allowlist. Only callout/layout HTML allowed; no scripts, iframes, or event handlers. |

---

## 13. Wiki-Link Resolution Algorithm

Implements Obsidian's basename-first shortest-path:

```
1. Strip .md extension and fragment (#heading, #^block)
2. Case-insensitive lookup in note basename index
3. If unique match → resolved
4. If multiple matches → prefer shortest relative path from source note
5. If link contains '/' → path suffix match against all note paths
6. Check frontmatter aliases
7. If no match → unresolved edge (target_id = NULL)
```

This is the main parsing component we implement from scratch because correct Obsidian-style link resolution is load-bearing for the vault experience. More broadly, policy resolution, scoped visibility, and governed traversal are also native ellul.ai components and are not delegated to third-party libraries. ~100 lines for the resolver itself.

---

## 14. UI Integration

### Dashboard Navigation

Add `"vault"` to `APP_CONTEXTS` in `useDashboardNav.ts`:
```typescript
const APP_CONTEXTS = ["workspace", "vault", "deployed", "database", "observability", "migrations", "settings"] as const;
const VAULT_TABS = ["notes", "graph", "scopes"] as const;
```

### New Components

| Component | Path | Purpose |
|-----------|------|---------|
| `TabVault.tsx` | `components/dashboard/tabs/` | Top-level vault tab container |
| `VaultNotesBrowser.tsx` | `components/dashboard/vault/` | Two-pane: tree + note view |
| `VaultNoteRenderer.tsx` | `components/dashboard/vault/` | Obsidian-flavored markdown renderer |
| `VaultGraphView.tsx` | `components/dashboard/vault/` | Force-directed graph |
| `VaultScopesManager.tsx` | `components/dashboard/vault/` | Scope CRUD with rule builder |
| `VaultBacklinksPane.tsx` | `components/dashboard/vault/` | Backlinks + restricted count |
| `ShareLinkDialog.tsx` | `components/dashboard/vault/` | Create/manage share links + capability tokens |
| `VaultContext.tsx` | `contexts/` | Active note, scope, search state |
| `useVault.ts` | `hooks/` | React Query hooks for vault API |

### Markdown Rendering Stack

Already installed: `react-markdown`, `remark-gfm`, `prism-react-renderer`

Add: `remark-math` + `rehype-katex` (math), `rehype-raw` + `rehype-sanitize` (HTML with strict allowlist), `rehype-slug` (heading anchors), `gray-matter` (frontmatter), `mermaid` (diagrams, lazy-loaded).

Custom remark plugins in `apps/console/src/lib/vault-markdown/`:
- `remark-obsidian-wikilink.ts` (~120 lines)
- `remark-obsidian-callout.ts` (~80 lines)
- `remark-obsidian-embed.ts` (~60 lines)
- `remark-obsidian-tags.ts` (~40 lines)
- `remark-inline-fields.ts` (~50 lines)

### Graph Visualization

Library (v1): `react-force-graph-2d` (~30KB gzip, Canvas-based, handles 1000+ nodes at 60fps). v1 choice — revisit if we need large graph scaling, deterministic layouts, richer interaction semantics, or enterprise inspectability.

Node rendering:
- **Visible**: Full color, labeled, clickable → navigates to note
- **Restricted** (human collaborator): Gray ghost circle, dashed edges, restricted count indicator
- **Phantom** (agent with `boundary_disclosure`): Opaque circle, no label, terminal
- **Hidden** (agent default, or fully out of scope): Absent entirely (not in response data)

---

## 15. Phased Implementation

### Phase 1: Core Infrastructure + Human Access

**Goal:** Vault CRUD, index, search, graph — accessible to humans via browser only.

**New files in sovereign-shield:**
- `services/vault-index.service.ts` — markdown parser, FTS5, fswatch
- `services/vault-scope.service.ts` — scope CRUD, rule evaluation, membership materialization
- `services/vault-graph.service.ts` — graph queries, neighborhood, backlinks
- `routes/vault.routes.ts` — browser-facing endpoints
- `routes/vault-internal.routes.ts` — stub

**Modify in sovereign-shield:** `routes/index.ts` (register), `database.ts` (init vault DB)

**New in console:** TabVault, VaultNotesBrowser, VaultNoteRenderer, VaultBacklinksPane, VaultContext, useVault, vault-markdown plugins

**Modify in console:** useDashboardNav, MobileDashboardLayout, package.json

**Modify in platform DB:** schema.ts (add `vaults` table), new migration

### Phase 2: Agent Access + Scoped Projections

**Goal:** Agents can query vault through bridge, scoped by policy.

**Modify in shield:** gate-permissions (add `vault_read`), gate.service (TTL), internal-auth (ACL), vault-internal.routes (implement), vault-scope (phantoms, clamping, sessions)

**New in agent-bridge:** vault-proxy.service.ts

**Modify in agent-bridge:** main.ts (WebSocket types), context.service (vault injection)

### Phase 3: Graph View, Links, Polish

**Goal:** Interactive graph, share links, capability tokens, real-time index updates.

**New in shield:** vault-links.service.ts

**New in console:** VaultGraphView, VaultScopesManager, ShareLinkDialog

**Modify:** realtime-provider (vault_index_changed), file-api websocket (broadcast), console package.json (react-force-graph-2d)

---

## 16. Code Change Map

### New Files (~23)

| File | Module | Est. Lines |
|------|--------|-----------|
| `sovereign-shield/src/services/vault-index.service.ts` | Shield | ~400 |
| `sovereign-shield/src/services/vault-scope.service.ts` | Shield | ~300 |
| `sovereign-shield/src/services/vault-graph.service.ts` | Shield | ~200 |
| `sovereign-shield/src/services/vault-links.service.ts` | Shield | ~200 |
| `sovereign-shield/src/services/vault-watcher.service.ts` | Shield | ~80 |
| `sovereign-shield/src/routes/vault.routes.ts` | Shield | ~350 |
| `sovereign-shield/src/routes/vault-internal.routes.ts` | Shield | ~200 |
| `packages/vps/src/services/shared/vault-types.ts` | Shared | ~80 |
| `agent-bridge/src/services/vault-proxy.service.ts` | Bridge | ~120 |
| `console/src/components/dashboard/tabs/TabVault.tsx` | Console | ~60 |
| `console/src/components/dashboard/vault/VaultNotesBrowser.tsx` | Console | ~250 |
| `console/src/components/dashboard/vault/VaultNoteRenderer.tsx` | Console | ~200 |
| `console/src/components/dashboard/vault/VaultGraphView.tsx` | Console | ~180 |
| `console/src/components/dashboard/vault/VaultScopesManager.tsx` | Console | ~200 |
| `console/src/components/dashboard/vault/VaultBacklinksPane.tsx` | Console | ~80 |
| `console/src/components/dashboard/vault/ShareLinkDialog.tsx` | Console | ~120 |
| `console/src/contexts/VaultContext.tsx` | Console | ~60 |
| `console/src/hooks/useVault.ts` | Console | ~100 |
| `console/src/lib/vault-markdown/remark-obsidian-wikilink.ts` | Console | ~120 |
| `console/src/lib/vault-markdown/remark-obsidian-callout.ts` | Console | ~80 |
| `console/src/lib/vault-markdown/remark-obsidian-embed.ts` | Console | ~60 |
| `console/src/lib/vault-markdown/remark-obsidian-tags.ts` | Console | ~40 |
| `console/src/lib/vault-markdown/remark-inline-fields.ts` | Console | ~50 |

### Modified Files (~13)

| File | Change |
|------|--------|
| `sovereign-shield/src/routes/index.ts` | Add `registerVaultRoutes(app)` + import |
| `sovereign-shield/src/services/gate-permissions.service.ts` | Add `vault_read` to `GateType` union + `VALID_GATE_TYPES` |
| `sovereign-shield/src/services/gate.service.ts` | Add `vault_read` default TTL |
| `sovereign-shield/src/middleware/internal-auth.middleware.ts` | Add vault ACL entry |
| `sovereign-shield/src/database.ts` | Initialize vault index DB |
| `packages/db/src/schema.ts` | Add `vaults` table |
| `agent-bridge/src/main.ts` | Add vault WebSocket message types |
| `agent-bridge/src/services/context.service.ts` | Optional vault context injection |
| `file-api/src/websocket.service.ts` | Broadcast `vault_index_changed` |
| `console/src/hooks/useDashboardNav.ts` | Add `"vault"` to APP_CONTEXTS + VAULT_TABS |
| `console/src/components/dashboard/MobileDashboardLayout.tsx` | Wire vault tab/context |
| `console/src/providers/realtime-provider.tsx` | Handle `vault_index_changed` |
| `console/package.json` | Add markdown/graph packages |
