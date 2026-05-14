// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

export interface FileNode {
  name: string;
  type: "file" | "dir";
  path: string;
  mtime?: number;
  children?: FileNode[];
}

export interface GitChange {
  status: string;
  file: string;
  // For renames (R), the original path before rename
  oldPath?: string;
}

export type ViewMode = "files" | "changes";

// ─── Tab system ──────────────────────────────────────────────────────────────

export type TabStatus = "normal" | "stale" | "diff" | "deleted";

export interface Tab {
  path: string;
  content: string;
  language: string;
  isDiff: boolean;
  status: TabStatus;
  // Timestamp for LRU eviction
  lastAccessed: number;
}

// ─── File capabilities (derived per-tab, not persisted) ──────────────────────

export interface FileCapabilities {
  canView: boolean;      // text file under MAX_FILE_SIZE
  canBlame: boolean;     // canView AND normal tab (not diff) AND .git exists
  canHistory: boolean;   // normal tab (not diff) AND .git exists
  isBinary: boolean;     // extension in BINARY_EXTENSIONS
  isTooLarge: boolean;   // exceeds MAX_FILE_SIZE
  isDiff: boolean;       // tab shows a diff, not file content
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  file: string;          // relative to project root
  line: number;
  content: string;       // line text, max 500 chars, centered on match
}

// ─── Git blame / history ─────────────────────────────────────────────────────

export interface BlameLine {
  sha: string;
  author: string;
  summary: string;       // commit subject line
  date: string;          // ISO 8601
  lineNumber: number;
  content: string;
}

export interface Commit {
  sha: string;
  message: string;
  author: string;
  date: string;          // ISO 8601
}

// ─── Review action context types ─────────────────────────────────────────────

export type AskContext = "full_file" | "selection" | "search_result" | "blame" | "diff";
export type FixContext = "diff" | "search_result" | "selection" | "full_file";

// ─── Project metadata ────────────────────────────────────────────────────────

export type AppType = "frontend" | "backend" | "library" | "monorepo" | "unknown";

export interface EllulJson {
  displayName: string;
  type: AppType;
  previewable: boolean;
  origin: "blank" | "git";
  createdAt: string;
  pinned: boolean;
  framework: string | null;
}
