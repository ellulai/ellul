// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// File API Configuration

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Derive all user paths from the runtime user's home directory
export const HOME = os.homedir();

// Server configuration
export const PORT = 3002;
export const ROOT_DIR = `${HOME}/projects`;

/** Resolve a relative app directory (`<sandbox>/<app>`) to its absolute path under ROOT_DIR. */
export function getAppPath(appDirectory: string): string {
  return path.join(ROOT_DIR, appDirectory);
}

// File paths
export const DEPLOYMENT_MODEL = (() => {
  try { return fs.readFileSync("/etc/ellul/deployment-model", "utf8").trim(); }
  catch { return ""; }
})();

export const PATHS = {
  TIER: "/etc/ellul/security-tier",
  SERVER_ID: "/etc/ellul-bootstrap/server-id",
  API_URL: "/etc/ellul/api-url",
  AI_PROXY_TOKEN: "/etc/ellul-bootstrap/ai-proxy-token",
  DOMAIN: "/etc/ellul/domain",
  JWT_SECRET: "/etc/ellul/jwt-secret",
  SSH_AUTH_KEYS: `${HOME}/.ssh/authorized_keys`,
} as const;

// Ignored patterns for file tree
export const IGNORED_PATTERNS = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  "coverage",
  ".nyc_output",
  "vendor",
  ".idea",
  ".vscode",
  "*.log",
  ".DS_Store",
  "Thumbs.db",
  ".ellul",
  ".ellul-install.lock",
  ".zeroclaw",
] as const;

// name and we never reserve generic English words from the user's namespace.
export const ZEROCLAW_DIRS = new Set(["cron", "memory", "sessions", "state"]);

// Binary file extensions (don't read content)
export const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".mp3",
  ".mp4",
  ".wav",
  ".avi",
  ".mov",
  ".mkv",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".pyc",
  ".pyo",
  ".class",
]);

// Max file size for reading
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

// WebSocket debounce time for file changes (ms).
// Must be long enough that npm install's rapid file creation doesn't
// trigger hundreds of broadcast cycles. 2s is responsive for human edits
// while coalescing bulk writes into a single tick.
export const DEBOUNCE_MS = 2000;

// Security tiers
export type SecurityTier = "standard" | "web_locked" | "private_locked";

export const TIERS = {
  STANDARD: "standard" as SecurityTier,
  WEB_LOCKED: "web_locked" as SecurityTier,
} as const;

// App framework detection patterns
export const FRAMEWORK_PATTERNS = {
  nextjs: {
    files: ["next.config.js", "next.config.mjs", "next.config.ts"],
    packageJson: ["next"],
  },
  remix: {
    files: ["remix.config.js"],
    packageJson: ["@remix-run/react"],
  },
  astro: {
    files: ["astro.config.mjs", "astro.config.ts"],
    packageJson: ["astro"],
  },
  vite: {
    files: ["vite.config.js", "vite.config.ts"],
    packageJson: ["vite"],
  },
  cra: {
    files: [],
    packageJson: ["react-scripts"],
  },
  express: {
    files: [],
    packageJson: ["express"],
  },
  fastify: {
    files: [],
    packageJson: ["fastify"],
  },
  hono: {
    files: [],
    packageJson: ["hono"],
  },
  nestjs: {
    files: ["nest-cli.json"],
    packageJson: ["@nestjs/core"],
  },
  koa: {
    files: [],
    packageJson: ["koa"],
  },
  html: {
    files: ["index.html"],
    packageJson: [],
  },
  // Monorepo workspace tools — detected at the root, even when apps/packages
  turbo: {
    files: ["turbo.json"],
    packageJson: ["turbo"],
  },
  nx: {
    files: ["nx.json"],
    packageJson: ["nx"],
  },
  lerna: {
    files: ["lerna.json"],
    packageJson: ["lerna"],
  },
  "pnpm-workspace": {
    files: ["pnpm-workspace.yaml"],
    packageJson: [],
  },
} as const;

// Default ports by framework
export const DEFAULT_PORTS: Record<string, number> = {
  nextjs: 3000,
  remix: 3000,
  astro: 4321,
  vite: 5173,
  cra: 3000,
  express: 3000,
  fastify: 3000,
  hono: 3000,
  nestjs: 3000,
  koa: 3000,
  html: 3000,
  dotnet: 5000,
  "spring-boot": 8080,
  "spring-boot-gradle": 8080,
  "java-maven": 8080,
  "java-gradle": 8080,
  bun: 3000,
  unknown: 3000,
};

const PLATFORM_ZONE = (() => {
  try { return fs.readFileSync("/etc/ellul/platform-zone", "utf8").trim(); }
  catch { return ""; }
})();

// CORS allowed origins
export const ALLOWED_ORIGINS = [
  ...(PLATFORM_ZONE ? [`https://${PLATFORM_ZONE}`, `https://www.${PLATFORM_ZONE}`] : []),
  "http://localhost:3000",
  "http://localhost:5173",
];

// Unauthorized HTML response
export const UNAUTHORIZED_HTML = `<!DOCTYPE html>
<html>
<head><title>Unauthorized</title></head>
<body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
<div style="text-align: center;">
<h1 style="color: #dc2626;">401 Unauthorized</h1>
<p>Authentication required. Please sign in to access the file browser.</p>
</div>
</body>
</html>`;
