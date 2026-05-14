// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul rules — Guardrail rule management CLI
 *
 * Commands:
 *   ellul rules list              List all rules
 *   ellul rules add <file.scm>   Add custom rule
 *   ellul rules proposals         List pending agent proposals
 *   ellul rules approve <id>     Approve proposal
 *   ellul rules deny <id>        Deny proposal
 */

import * as fs from 'fs';
import * as path from 'path';
import { LocalRuleStore } from '../index';

const CONFIG_DIR = path.join(process.env.HOME || '~', '.ellul');
const GUARDRAILS_DIR = path.join(CONFIG_DIR, 'guardrails');

function openRuleStore(): LocalRuleStore {
  return new LocalRuleStore(GUARDRAILS_DIR);
}

export async function handleRules(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'list': {
      const store = openRuleStore();
      const rules = store.listRules();
      store.close();

      if (rules.length === 0) {
        process.stderr.write('No guardrail rules. This should not happen — default rules are seeded on init.\n');
        return;
      }

      process.stderr.write(`Guardrail rules (${rules.length}):\n\n`);
      for (const r of rules) {
        const status = r.enabled ? 'active' : 'disabled';
        const lock = r.locked ? ' [locked]' : '';
        process.stderr.write(`  ${r.id}\n`);
        process.stderr.write(`    ${r.name} (${r.language}) — ${status}${lock}\n`);
        process.stderr.write(`    ${r.message}\n\n`);
      }
      break;
    }

    case 'add': {
      const file = args[1];
      if (!file) {
        process.stderr.write('Usage: ellul rules add <file.scm>\n');
        process.exit(1);
      }

      if (!fs.existsSync(file)) {
        process.stderr.write(`Error: File not found: ${file}\n`);
        process.exit(1);
      }

      const content = fs.readFileSync(file, 'utf8');
      const basename = path.basename(file, '.scm');
      const underscoreIdx = basename.indexOf('_');

      if (underscoreIdx < 1) {
        process.stderr.write('Error: Filename must be <language>_<rule-name>.scm (e.g., go_no-panic.scm)\n');
        process.exit(1);
      }

      const language = basename.slice(0, underscoreIdx);
      const ruleName = basename.slice(underscoreIdx + 1);

      const store = openRuleStore();
      try {
        const id = store.addRule({
          scope: 'workspace',
          language,
          name: ruleName,
          query_scm: content.trim(),
          message: `Custom rule: ${ruleName}`,
        });
        process.stderr.write(`✓ Rule added: ${id}\n`);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      } finally {
        store.close();
      }
      break;
    }

    case 'proposals': {
      const store = openRuleStore();
      const proposals = store.listPendingProposals();
      store.close();

      if (proposals.length === 0) {
        process.stderr.write('No pending proposals.\n');
        return;
      }

      process.stderr.write(`Pending proposals (${proposals.length}):\n\n`);
      for (const p of proposals) {
        process.stderr.write(`  ${p.id} [${p.action}]\n`);
        process.stderr.write(`    Reason: ${p.reason}\n`);
        process.stderr.write(`    Proposed: ${p.created_at}\n\n`);
      }
      break;
    }

    case 'approve': {
      const id = args[1];
      if (!id) {
        process.stderr.write('Usage: ellul rules approve <proposal-id>\n');
        process.exit(1);
      }

      const store = openRuleStore();
      try {
        store.approveProposal(id);
        process.stderr.write(`✓ Proposal ${id} approved and materialized\n`);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      } finally {
        store.close();
      }
      break;
    }

    case 'deny': {
      const id = args[1];
      if (!id) {
        process.stderr.write('Usage: ellul rules deny <proposal-id>\n');
        process.exit(1);
      }

      const store = openRuleStore();
      try {
        store.denyProposal(id);
        process.stderr.write(`✗ Proposal ${id} denied\n`);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      } finally {
        store.close();
      }
      break;
    }

    default:
      process.stderr.write(
        'Usage: ellul rules <list|add|proposals|approve|deny>\n\n' +
        '  list                List all guardrail rules\n' +
        '  add <file.scm>     Add custom rule\n' +
        '  proposals           List pending agent proposals\n' +
        '  approve <id>        Approve proposal\n' +
        '  deny <id>           Deny proposal\n',
      );
      if (subcommand) process.exit(1);
  }
}
