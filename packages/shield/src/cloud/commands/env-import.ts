// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * env import — Import .env files into ellul encrypted vault
 *
 * Supports:
 *   ellul env import .env                  -> import single file
 *   ellul env import .env .env.local       -> import multiple files
 *   ellul env import --auto                -> auto-discover .env* files in cwd
 *   ellul env import .env --app myapp      -> target specific app
 *   ellul env import .env --env development -> target specific environment
 *   ellul env import --dry-run .env        -> preview without uploading
 *   cat .env | ellul env import -          -> read from stdin
 *
 * Agent-friendly:
 *   - --json output with consistent envelope
 *   - --help with examples
 *   - --dry-run for safe preview
 *   - stdin support for pipelines
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ParsedArgs } from '../../lib/flags';
import { fail, success, info, EXIT, isJsonMode } from '../../lib/output';
import { showCommandHelp, registerCommand } from '../../lib/help';
import { requireProxyPort } from '../../lib/context';
import { parseEnvContent, detectEnvironmentFromFilename, isEnvFile } from '../../shared/env-parser';
import { fetchPublicKey, encryptAndUploadBulk } from '../cli-crypto';

const SECRET_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

registerCommand({
  name: 'env import',
  summary: 'Import .env files into encrypted vault',
  usage: 'ellul env import [files...] [options]',
  flags: [
    { name: 'auto', description: 'Auto-discover .env* files in current directory' },
    { name: 'app', description: 'Target app (default: _global)', valueHint: 'name' },
    { name: 'env', description: 'Force environment', valueHint: 'production|development' },
    { name: 'dry-run', description: 'Preview parsed entries without uploading' },
  ],
  examples: [
    'ellul env import .env',
    'ellul env import .env .env.local',
    'ellul env import --auto --json',
    'ellul env import .env --app myapp --env=development',
    'ellul env import --dry-run .env',
    'cat .env | ellul env import -',
  ],
});

interface ImportOptions {
  files: string[];
  auto: boolean;
  app?: string;
  env?: 'production' | 'development';
  dryRun: boolean;
  stdin: boolean;
}

function parseImportFromParsedArgs(args: ParsedArgs): ImportOptions {
  const opts: ImportOptions = {
    // Positional args after 'env' and 'import' are file paths
    files: args.positional.slice(2).filter(a => a !== '-'),
    auto: args.has('auto'),
    app: args.get('app'),
    dryRun: args.has('dry-run'),
    stdin: args.positional.includes('-'),
  };

  const envVal = args.get('env');
  if (envVal) {
    if (envVal !== 'production' && envVal !== 'development') {
      fail(EXIT.USAGE, 'env import', `Invalid --env value: "${envVal}". Must be "production" or "development".`);
    }
    opts.env = envVal as 'production' | 'development';
  }

  if (!opts.auto && opts.files.length === 0 && !opts.stdin) {
    fail(
      EXIT.USAGE,
      'env import',
      'No files specified.',
      'Usage: ellul env import .env [--auto] [--dry-run] [--app=name] [--env=production|development]',
    );
  }

  return opts;
}

function discoverEnvFiles(dir: string): string[] {
  const files: string[] = [];

  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!isEnvFile(entry)) continue;
      const fullPath = path.join(dir, entry);

      try {
        const stat = fs.lstatSync(fullPath);
        if (!stat.isFile()) continue;
        if (stat.isSymbolicLink()) {
          process.stderr.write(`[env import] Skipping symlink: ${entry}\n`);
          continue;
        }
      } catch {
        continue;
      }

      const env = detectEnvironmentFromFilename(entry);
      if (env === null) {
        process.stderr.write(`[env import] Skipping template: ${entry}\n`);
        continue;
      }

      files.push(fullPath);
    }
  } catch (err) {
    fail(EXIT.NETWORK, 'env import', `Failed to scan directory: ${(err as Error).message}`);
  }

  files.sort((a, b) => {
    const aBase = path.basename(a);
    const bBase = path.basename(b);
    if (aBase === '.env') return -1;
    if (bBase === '.env') return 1;
    return aBase.localeCompare(bBase);
  });

  return files;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);

    if (process.stdin.isTTY) {
      reject(new Error('No piped input detected. Use: cat .env | ellul env import -'));
    }
  });
}

export async function envImportCommand(args: ParsedArgs): Promise<void> {
  if (args.has('help')) {
    showCommandHelp('env import');
    process.exit(0);
  }

  const opts = parseImportFromParsedArgs(args);
  const appName = opts.app || '_global';

  interface FileSource {
    path: string;
    content: string;
    detectedEnv: 'production' | 'development';
  }

  const sources: FileSource[] = [];

  if (opts.stdin) {
    const content = await readStdin();
    sources.push({
      path: '<stdin>',
      content,
      detectedEnv: opts.env || 'production',
    });
  }

  if (opts.auto) {
    const discovered = discoverEnvFiles(process.cwd());
    if (discovered.length === 0) {
      fail(EXIT.USAGE, 'env import', 'No .env files found in current directory.');
    }
    for (const filePath of discovered) {
      const detectedEnv = opts.env || detectEnvironmentFromFilename(filePath) || 'production';
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) continue;

      sources.push({
        path: filePath,
        content: fs.readFileSync(filePath, 'utf8'),
        detectedEnv,
      });
    }
  }

  for (const filePath of opts.files) {
    const resolved = path.resolve(filePath);

    try {
      const stat = fs.lstatSync(resolved);
      if (stat.isSymbolicLink()) {
        fail(EXIT.USAGE, 'env import', `Refusing to read symlink: ${filePath}`);
      }
      if (!stat.isFile()) {
        fail(EXIT.USAGE, 'env import', `Not a file: ${filePath}`);
      }
    } catch {
      fail(EXIT.USAGE, 'env import', `File not found: ${filePath}`);
    }

    const content = fs.readFileSync(resolved, 'utf8');
    const detectedEnv = opts.env || detectEnvironmentFromFilename(path.basename(resolved)) || 'production';
    sources.push({ path: resolved, content, detectedEnv });
  }

  if (sources.length === 0) {
    fail(EXIT.USAGE, 'env import', 'No files to import.');
  }

  // Parse all files and group by target environment
  const byEnv: Record<string, Array<{ key: string; value: string; source: string }>> = {
    production: [],
    development: [],
  };

  let totalWarnings = 0;
  const allSensitiveKeys: string[] = [];

  for (const source of sources) {
    const result = parseEnvContent(source.content);
    const displayPath = source.path === '<stdin>' ? '<stdin>' : path.relative(process.cwd(), source.path) || source.path;

    for (const warning of result.warnings) {
      info('env import', `${displayPath}: ${warning}`);
      totalWarnings++;
    }

    if (result.entries.length === 0) {
      info('env import', `${displayPath}: No valid entries found.`);
      continue;
    }

    for (const entry of result.entries) {
      if (!SECRET_NAME_REGEX.test(entry.key)) {
        info('env import', `${displayPath}: Skipping invalid key "${entry.key}" (line ${entry.line})`);
        continue;
      }

      byEnv[source.detectedEnv]!.push({
        key: entry.key,
        value: entry.value,
        source: displayPath,
      });
    }

    allSensitiveKeys.push(...result.detectedSensitiveKeys);
    info('env import', `${displayPath}: ${result.entries.length} entries -> ${source.detectedEnv}`);
  }

  // Dedup within each environment (last file wins for conflicts)
  for (const env of ['production', 'development'] as const) {
    const entries = byEnv[env]!;
    const deduped = new Map<string, { key: string; value: string; source: string }>();
    for (const entry of entries) {
      if (deduped.has(entry.key)) {
        const prev = deduped.get(entry.key)!;
        info('env import', `${env}: ${entry.key} overridden (${prev.source} -> ${entry.source})`);
      }
      deduped.set(entry.key, entry);
    }
    byEnv[env] = [...deduped.values()];
  }

  const prodCount = byEnv.production!.length;
  const devCount = byEnv.development!.length;
  const totalCount = prodCount + devCount;

  if (totalCount === 0) {
    fail(EXIT.USAGE, 'env import', 'No valid entries to import.');
  }

  // Summary (human mode only)
  if (!isJsonMode()) {
    process.stderr.write('\n');
    process.stderr.write(`  Import summary:\n`);
    process.stderr.write(`    App:          ${appName}\n`);
    if (prodCount > 0) process.stderr.write(`    Production:   ${prodCount} variables\n`);
    if (devCount > 0) process.stderr.write(`    Development:  ${devCount} variables\n`);
    if (totalWarnings > 0) process.stderr.write(`    Warnings:     ${totalWarnings}\n`);
    if (allSensitiveKeys.length > 0) process.stderr.write(`    Sensitive:    ${allSensitiveKeys.length} keys detected as sensitive\n`);
    process.stderr.write('\n');
  }

  // Dry run
  if (opts.dryRun) {
    if (!isJsonMode()) {
      for (const env of ['production', 'development'] as const) {
        const entries = byEnv[env]!;
        if (entries.length === 0) continue;
        process.stderr.write(`  ${env}:\n`);
        for (const entry of entries) {
          const masked = entry.value.length <= 4
            ? '****'
            : entry.value.slice(0, 3) + '***' + entry.value.slice(-2);
          process.stderr.write(`    ${entry.key}=${masked}\n`);
        }
        process.stderr.write('\n');
      }
      process.stderr.write('[env import] Dry run — no changes made.\n');
    }
    success({
      dryRun: true,
      app: appName,
      environments: { production: prodCount, development: devCount },
      warnings: totalWarnings,
    });
    return;
  }

  // Get proxy port and public key
  const proxyPort = requireProxyPort('env import');
  let publicKey: string;

  try {
    publicKey = await fetchPublicKey(proxyPort);
  } catch (err) {
    fail(
      EXIT.NETWORK,
      'env import',
      `Failed to fetch VPS public key: ${(err as Error).message}`,
      'Ensure the daemon is running and authenticated.',
    );
  }

  // Encrypt and upload
  let uploaded = 0;
  for (const env of ['production', 'development'] as const) {
    const entries = byEnv[env]!;
    if (entries.length === 0) continue;

    info('env import', `Encrypting ${entries.length} ${env} secrets...`);

    try {
      const count = await encryptAndUploadBulk(
        proxyPort,
        publicKey,
        entries.map(e => ({ key: e.key, value: e.value })),
        appName,
        env,
      );
      uploaded += count;
      info('env import', `${count} ${env} secrets imported successfully.`);
    } catch (err) {
      fail(EXIT.NETWORK, 'env import', `Failed to import ${env} secrets: ${(err as Error).message}`);
    }
  }

  info('env import', `Done. ${uploaded} secrets imported for ${appName}.`);

  success({
    imported: uploaded,
    app: appName,
    environments: { production: prodCount, development: devCount },
    warnings: totalWarnings,
    dryRun: false,
  });
}
