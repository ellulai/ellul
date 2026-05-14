// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul init — Initialize a local project for free-tier governance
 *
 * Creates:
 *   .ellul/project.json       Project identity (slug, name, createdAt)
 *   .ellul/secrets.db          Encrypted secret store (empty)
 *   .ellul/policies/           Policy mirror directory
 *   .ellul/policies/proposed/  Agent proposal staging area
 *   .mcp.json                  MCP server config for agent discovery
 *
 * Also:
 *   - Ensures ~/.ellul/ exists (mode 0700)
 *   - Initializes master secret in keychain if first project
 *   - Seeds default guardrail rules if first project
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { initMasterSecret, deriveKeys, LocalRuleStore, LocalSecretStore } from '../index';

const CONFIG_DIR = path.join(process.env.HOME || '~', '.ellul');
const GUARDRAILS_DIR = path.join(CONFIG_DIR, 'guardrails');

function generateSlug(name: string): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 20);
  const suffix = crypto.randomBytes(4).toString('hex');
  return `local-${clean}-${suffix}`;
}

export async function handleLocalInit(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const name = args[0] || path.basename(cwd);
  const projectDir = path.join(cwd, '.ellul');
  const projectFile = path.join(projectDir, 'project.json');

  // Check if already initialized
  if (fs.existsSync(projectFile)) {
    const existing = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    process.stderr.write(`Project already initialized: ${existing.projectName || existing.projectSlug}\n`);
    process.stderr.write(`  slug: ${existing.projectSlug}\n`);
    process.stderr.write(`  path: ${cwd}\n`);
    process.stderr.write(`\nTo reinitialize, delete .ellul/project.json first.\n`);
    return;
  }

  const log = (msg: string) => process.stderr.write(`${msg}\n`);

  // ── 1. Ensure global config dir ──
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

  // ── 2. Initialize master secret (keychain preferred) ──
  const master = initMasterSecret(log);
  const keys = deriveKeys(master);

  // ── 3. Generate project identity ──
  const slug = generateSlug(name);
  const projectConfig = {
    mode: 'local' as const,
    projectSlug: slug,
    projectName: name,
    createdAt: new Date().toISOString(),
  };

  // ── 4. Create project directories ──
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'policies', 'proposed'), { recursive: true });

  // ── 5. Write project.json ──
  fs.writeFileSync(projectFile, JSON.stringify(projectConfig, null, 2) + '\n');
  process.stderr.write(`✓ Generated project slug: ${slug}\n`);
  process.stderr.write(`✓ Workspace root: ${cwd} (canonical)\n`);
  process.stderr.write(`✓ Created .ellul/project.json\n`);

  // ── 6. Initialize secrets.db ──
  const secretsDb = path.join(projectDir, 'secrets.db');
  const secretStore = new LocalSecretStore(secretsDb, keys.secretsEncKey);
  secretStore.close();
  process.stderr.write(`✓ Initialized secrets store (.ellul/secrets.db)\n`);

  // ── 7. Initialize guardrail rule store (seeds defaults on first init) ──
  const ruleStore = new LocalRuleStore(GUARDRAILS_DIR);
  const rules = ruleStore.listRules();
  ruleStore.close();
  process.stderr.write(`✓ Guardrail rules: ${rules.length} active (${rules.filter(r => r.locked).length} locked)\n`);

  // ── 8. Write .mcp.json ──
  const mcpFile = path.join(cwd, '.mcp.json');
  if (!fs.existsSync(mcpFile)) {
    const mcpConfig = {
      mcpServers: {
        ellul: {
          command: 'ellul-mcp',
          args: [],
          env: {},
        },
      },
    };
    fs.writeFileSync(mcpFile, JSON.stringify(mcpConfig, null, 2) + '\n');
    process.stderr.write(`✓ Wrote .mcp.json (ellul-mcp configured)\n`);
  } else {
    process.stderr.write(`  .mcp.json already exists (not overwritten)\n`);
  }

  // ── 9. Add to .gitignore ──
  const gitignorePath = path.join(cwd, '.gitignore');
  const gitignoreEntries = ['.ellul/secrets.db', '.ellul/policies/proposed/'];
  if (fs.existsSync(gitignorePath)) {
    const existing = fs.readFileSync(gitignorePath, 'utf8');
    const toAdd = gitignoreEntries.filter(e => !existing.includes(e));
    if (toAdd.length > 0) {
      fs.appendFileSync(gitignorePath, '\n# ellul local governance\n' + toAdd.join('\n') + '\n');
      process.stderr.write(`✓ Updated .gitignore\n`);
    }
  }

  process.stderr.write(`\nReady. Run 'ellul' to start the daemon.\n`);
}
