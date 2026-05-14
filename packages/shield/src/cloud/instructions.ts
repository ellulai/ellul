// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Agent instruction blocks for CLAUDE.md/AGENTS.md/GEMINI.md/.cursorrules (+ .mcp.json).
// Managed between START/END markers; user content outside untouched.

import fs from 'fs/promises';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BlockFormat = 'html' | 'hash';

interface TargetFile {
  relativePath: string;
  format: BlockFormat;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGETS: TargetFile[] = [
  { relativePath: '.claude/CLAUDE.md', format: 'html' },
  { relativePath: 'AGENTS.md', format: 'html' },
    { relativePath: '.cursorrules', format: 'hash' },
];

const HTML_START =
  '<!-- ELLUL:START - Do not edit this block. Managed by ellul. Run `ellul sync` to update. -->';
const HTML_END = '<!-- ELLUL:END -->';

const HASH_START =
  '# === ELLUL:START - Do not edit this block. Managed by ellul. Run `ellul sync` to update. ===';
const HASH_END = '# === ELLUL:END ===';

// ---------------------------------------------------------------------------
// Block generation
// ---------------------------------------------------------------------------

export function generateInstructionBlock(projectName: string): string {
  // Sanitize project name to prevent marker injection (e.g., name containing ELLUL:END)
  const safeName = projectName.replace(/[<>]/g, '').replace(/ELLUL:(START|END)/g, 'ELLUL_$1');
  return [
    '## ellul Managed Environment',
    '',
    `This project (${safeName}) is managed by ellul. Use the ellul MCP tools for all gated operations.`,
    'Do NOT use raw system commands for these actions — use the MCP tools instead.',
    '',
    '### Database',
    '- Use `ellul_db_query` for ALL SQL operations (SELECT, INSERT, CREATE TABLE, etc.)',
    '- Do NOT run psql, pg_dump, or direct database commands',
    '',
    '### Git (Remote Operations)',
    '- ALWAYS use `ellul_git_push` and `ellul_git_pull` for remote git operations',
    '- NEVER run `git push`, `git pull`, or `git fetch` directly — use the MCP tools',
    '- Local git commands (add, commit, branch, diff, log, status) are fine',
    '',
    '### Secrets / Environment',
    '- Use `ellul_env_read` to access environment variables and secrets',
    '- Do NOT read .env files directly',
    '',
    '### Deployment',
    '- Use `ellul_deploy` to deploy the application',
    '',
    '### Gate Requests',
    '- If a tool returns `"error": "gate_closed"`, call `ellul_gate_request` with the gate name and a reason',
    '- The developer will approve or deny from their terminal',
    '- Do NOT retry immediately — wait for approval',
    '',
    '### Gate Management',
    '- You can open gates with `ellul_gate_grant` (e.g., `ellul_gate_grant({ gate: "db_write", duration: "10m", reason: "..." })`)',
    '- The developer MUST approve all gate openings from their terminal — you cannot bypass this',
    '- Prefer short durations (5m, 10m) over session or always',
    '- To change persistent policies, use `ellul_policy_set` — but explain what will change BEFORE calling it',
    '- NEVER silently change security policies — always tell the user what you\'re about to do and why',
    '- Check current state with `ellul_gate_status` and `ellul_policy_list` before requesting changes',
    '',
    '### Security Model',
    '- All git credentials are stored exclusively on the remote VPS in sovereign-shield process memory',
    '- Git push/pull, database, deploy, and exec are gated via cryptographic operator signatures (ECDSA P-256)',
    '- Enforcement is kernel-level: ptrace_scope=1, DAC file permissions, credential session isolation',
    '- The ONLY path to push code is through the ellul MCP tools — there are no credentials to use locally',
    '- If git is independently configured on the local machine (SSH keys, credential managers), those are outside the ellul security boundary',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Marker helpers
// ---------------------------------------------------------------------------

function markers(format: BlockFormat): { start: string; end: string } {
  return format === 'html'
    ? { start: HTML_START, end: HTML_END }
    : { start: HASH_START, end: HASH_END };
}

function wrapBlock(content: string, format: BlockFormat): string {
  const { start, end } = markers(format);
  return `${start}\n${content}\n${end}`;
}

// ---------------------------------------------------------------------------
// Managed block upsert
// ---------------------------------------------------------------------------

// Create/append/replace; content outside markers never touched.
export async function upsertManagedBlock(
  filePath: string,
  block: string,
  format: BlockFormat,
): Promise<void> {
  const wrapped = wrapBlock(block, format);
  const { start, end } = markers(format);

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Symlink protection: refuse to write through symlinks (prevents writing to arbitrary locations)
  let existing: string | null = null;
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to write managed block through symlink: ${filePath}`);
    }
    existing = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Refusing')) throw err;
    // File doesn't exist — will create
  }

  if (existing === null) {
    // Case 1: file doesn't exist — create with managed block only
    await fs.writeFile(filePath, wrapped + '\n');
    return;
  }

  const startIdx = existing.indexOf(start);
  const endIdx = existing.indexOf(end);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    // Case 2: file exists but no valid managed block — append
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '\n';
    await fs.writeFile(filePath, existing + separator + wrapped + '\n');
    return;
  }

  // Case 3: replace existing block (start marker through end marker inclusive)
  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + end.length);
  await fs.writeFile(filePath, before + wrapped + after);
}

// ---------------------------------------------------------------------------
// Managed block removal
// ---------------------------------------------------------------------------

/**
 * Removes between markers; deletes file + empty parent dir if now empty
 * (handles .claude/ and .cursor/ cleanup).
 *
 * Returns true if the block was found and removed.
 */
export async function removeManagedBlock(
  filePath: string,
  format: BlockFormat,
): Promise<boolean> {
  let existing: string;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch {
    return false; // File doesn't exist
  }

  const { start, end } = markers(format);
  const startIdx = existing.indexOf(start);
  const endIdx = existing.indexOf(end);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return false; // No valid managed block
  }

  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + end.length);
  const result = (before + after).replace(/\n{3,}/g, '\n\n').trim();

  if (result.length === 0) {
    // File is now empty — delete it
    await fs.unlink(filePath);
    // Try to remove parent dir if empty (e.g. .claude/, .cursor/)
    try {
      await fs.rmdir(path.dirname(filePath));
    } catch {
      // Directory not empty or doesn't exist — fine
    }
  } else {
    await fs.writeFile(filePath, result + '\n');
  }

  return true;
}

// ---------------------------------------------------------------------------
// .mcp.json removal
// ---------------------------------------------------------------------------

// Preserves other MCP entries; deletes file if last one.
export async function removeMcpEntry(filePath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return false;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  } catch {
    return false;
  }

  const servers = parsed.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== 'object' || !('ellul' in servers)) {
    return false;
  }

  delete servers.ellul;

  // If mcpServers is now empty, remove the key
  if (Object.keys(servers).length === 0) {
    delete parsed.mcpServers;
  }

  // If the whole object is now empty, delete the file
  if (Object.keys(parsed).length === 0) {
    await fs.unlink(filePath);
  } else {
    await fs.writeFile(filePath, JSON.stringify(parsed, null, 2) + '\n');
  }

  return true;
}

// ---------------------------------------------------------------------------
// Remove all
// ---------------------------------------------------------------------------

export async function removeAllInstructionFiles(): Promise<string[]> {
  const cwd = process.cwd();
  const removed: string[] = [];

  for (const target of TARGETS) {
    const filePath = path.join(cwd, target.relativePath);
    const didRemove = await removeManagedBlock(filePath, target.format);
    if (didRemove) removed.push(target.relativePath);
  }

  const mcpPath = path.join(cwd, '.mcp.json');
  const didRemoveMcp = await removeMcpEntry(mcpPath);
  if (didRemoveMcp) removed.push('.mcp.json');

  return removed;
}

// ---------------------------------------------------------------------------
// .mcp.json upsert
// ---------------------------------------------------------------------------

export async function upsertMcpJson(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // File doesn't exist or isn't valid JSON — start fresh
  }

  const servers =
    existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers)
      ? (existing.mcpServers as Record<string, unknown>)
      : {};

  servers.ellul = {
    command: 'npx',
    args: ['ellul-mcp'],
  };

  existing.mcpServers = servers;

  await fs.writeFile(filePath, JSON.stringify(existing, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Sync all
// ---------------------------------------------------------------------------

export async function syncAllInstructionFiles(projectName: string): Promise<string[]> {
  const cwd = process.cwd();
  const block = generateInstructionBlock(projectName);
  const written: string[] = [];

  for (const target of TARGETS) {
    const filePath = path.join(cwd, target.relativePath);
    await upsertManagedBlock(filePath, block, target.format);
    written.push(target.relativePath);
  }

  const mcpPath = path.join(cwd, '.mcp.json');
  await upsertMcpJson(mcpPath);
  written.push('.mcp.json');

  return written;
}
