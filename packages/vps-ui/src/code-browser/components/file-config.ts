// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// File extension to icon, color, and language mapping.

import {
  File,
  Code2,
  Braces,
  Hash,
  FileJson,
  FileText,
  Terminal,
  Image,
  Settings,
  Database,
} from "lucide-react";

export const FILE_CONFIG: Record<
  string,
  { icon: typeof File; color: string; language: string }
> = {
  // TypeScript/JavaScript
  ".ts": { icon: Code2, color: "text-blue-400", language: "typescript" },
  ".tsx": { icon: Code2, color: "text-blue-400", language: "tsx" },
  ".js": { icon: Braces, color: "text-sodium", language: "javascript" },
  ".jsx": { icon: Braces, color: "text-sodium", language: "jsx" },
  ".mjs": { icon: Braces, color: "text-sodium", language: "javascript" },
  ".cjs": { icon: Braces, color: "text-sodium", language: "javascript" },
  // Web
  ".html": { icon: Code2, color: "text-sodium", language: "html" },
  ".htm": { icon: Code2, color: "text-sodium", language: "html" },
  ".css": { icon: Hash, color: "text-pink-400", language: "css" },
  ".scss": { icon: Hash, color: "text-pink-500", language: "scss" },
  ".sass": { icon: Hash, color: "text-pink-500", language: "sass" },
  ".less": { icon: Hash, color: "text-indigo-400", language: "less" },
  // Data
  ".json": { icon: FileJson, color: "text-sodium", language: "json" },
  ".yaml": { icon: FileJson, color: "text-cream/65", language: "yaml" },
  ".yml": { icon: FileJson, color: "text-cream/65", language: "yaml" },
  ".toml": { icon: FileJson, color: "text-sodium", language: "toml" },
  ".xml": { icon: FileJson, color: "text-green-400", language: "xml" },
  // Python
  ".py": { icon: Code2, color: "text-green-400", language: "python" },
  ".pyw": { icon: Code2, color: "text-green-400", language: "python" },
  ".pyx": { icon: Code2, color: "text-green-400", language: "python" },
  // Rust
  ".rs": { icon: Code2, color: "text-sodium", language: "rust" },
  // Go
  ".go": { icon: Code2, color: "text-cyan-400", language: "go" },
  // C/C++
  ".c": { icon: Code2, color: "text-blue-500", language: "c" },
  ".h": { icon: Code2, color: "text-blue-500", language: "c" },
  ".cpp": { icon: Code2, color: "text-blue-600", language: "cpp" },
  ".hpp": { icon: Code2, color: "text-blue-600", language: "cpp" },
  ".cc": { icon: Code2, color: "text-blue-600", language: "cpp" },
  // Java/Kotlin
  ".java": { icon: Code2, color: "text-terra", language: "java" },
  ".kt": { icon: Code2, color: "text-cream/65", language: "kotlin" },
  ".kts": { icon: Code2, color: "text-cream/65", language: "kotlin" },
  // Ruby
  ".rb": { icon: Code2, color: "text-terra", language: "ruby" },
  ".erb": { icon: Code2, color: "text-terra", language: "erb" },
  // PHP
  ".php": { icon: Code2, color: "text-indigo-400", language: "php" },
  // Shell
  ".sh": { icon: Terminal, color: "text-green-500", language: "bash" },
  ".bash": { icon: Terminal, color: "text-green-500", language: "bash" },
  ".zsh": { icon: Terminal, color: "text-green-500", language: "bash" },
  ".fish": { icon: Terminal, color: "text-green-500", language: "bash" },
  // SQL
  ".sql": { icon: Database, color: "text-blue-300", language: "sql" },
  // Markdown
  ".md": { icon: FileText, color: "text-cream/60", language: "markdown" },
  ".mdx": { icon: FileText, color: "text-cream/60", language: "mdx" },
  // Config
  ".env": { icon: Settings, color: "text-sodium", language: "bash" },
  ".gitignore": { icon: Settings, color: "text-cream/60", language: "git" },
  ".dockerignore": { icon: Settings, color: "text-cream/60", language: "git" },
  ".editorconfig": { icon: Settings, color: "text-cream/60", language: "ini" },
  ".prettierrc": { icon: Settings, color: "text-cream/60", language: "json" },
  ".eslintrc": { icon: Settings, color: "text-cream/60", language: "json" },
  // Images
  ".png": { icon: Image, color: "text-cream/65", language: "text" },
  ".jpg": { icon: Image, color: "text-cream/65", language: "text" },
  ".jpeg": { icon: Image, color: "text-cream/65", language: "text" },
  ".gif": { icon: Image, color: "text-cream/65", language: "text" },
  ".svg": { icon: Image, color: "text-sodium", language: "xml" },
  ".ico": { icon: Image, color: "text-cream/65", language: "text" },
  // Swift
  ".swift": { icon: Code2, color: "text-sodium", language: "swift" },
  // Dart
  ".dart": { icon: Code2, color: "text-cyan-500", language: "dart" },
  // Lua
  ".lua": { icon: Code2, color: "text-blue-400", language: "lua" },
  // Perl
  ".pl": { icon: Code2, color: "text-blue-400", language: "perl" },
  ".pm": { icon: Code2, color: "text-blue-400", language: "perl" },
  // GraphQL
  ".graphql": { icon: Code2, color: "text-pink-500", language: "graphql" },
  ".gql": { icon: Code2, color: "text-pink-500", language: "graphql" },
  // Prisma
  ".prisma": { icon: Database, color: "text-sodium", language: "prisma" },
  // Docker
  Dockerfile: { icon: Settings, color: "text-blue-400", language: "docker" },
};

export function getFileConfig(name: string) {
  if (FILE_CONFIG[name]) return FILE_CONFIG[name];
  const ext = name.includes(".") ? "." + name.split(".").pop()?.toLowerCase() : "";
  return FILE_CONFIG[ext] || { icon: File, color: "text-cream/60", language: "text" };
}

export function getStatusLabel(status: string): { label: string; color: string } {
  switch (status) {
    case "M": return { label: "Modified", color: "text-sodium" };
    case "A": return { label: "Added", color: "text-green-400" };
    case "D": return { label: "Deleted", color: "text-terra" };
    case "R": return { label: "Renamed", color: "text-cream/65" };
    case "??": return { label: "Untracked", color: "text-cream/60" };
    default: return { label: "Changed", color: "text-sodium" };
  }
}

export function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}
