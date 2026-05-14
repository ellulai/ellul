// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Daemon REPL — Interactive operator control plane
 *
 * Runs in the daemon process event loop. Has direct access to the operator
 * key for signing gate approvals, rule changes, and secret reveals.
 * Handles terminal resize, readline history, and gate request notifications.
 */

import * as readline from 'readline';
import { signOperatorAction } from '@ellul.ai/shield-proxy';

import {
  gateApprovePayload, gateDenyPayload, ruleApprovePayload,
  verifyOperatorSignature, secretRevealPayload,
} from '../crypto/index';
import { scanWorkspace, verifyAndRestoreIntegrity } from '../guardrails/scanner';
import type { GateRequest } from '../gates/index';
import type { GateType } from '../gates/capability-allowlist';
import { type LocalDaemonState, getSecretStore, reloadSecretEntries, CONFIG_DIR } from './state';

export async function startRepl(state: LocalDaemonState): Promise<readline.Interface> {
  const { logger, gateManager, ruleStore, operatorKey } = state;
  const prompt = state.execMode === 'unrestricted' ? 'ellul[unrestricted]> ' : 'ellul> ';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt,
    historySize: 100,
    removeHistoryDuplicates: true,
  });

  // Handle terminal resize
  process.stdout.on('resize', () => { rl.prompt(true); });

  const VALID_GATES = new Set<string>(['test', 'build', 'lint', 'dev', 'exec']);

  // Wire gate request callback
  gateManager.onGateRequest = (req: GateRequest) => {
    process.stderr.write('\r\x1b[K');
    process.stderr.write(`[gate] Agent requests: ${req.gate} — "${req.reason}"\n`);
    process.stderr.write('  1) Approve 5 min  2) Approve session  3) Always allow  4) Deny\n');
    rl.prompt(true);
  };

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    try {
      switch (cmd) {
        case '/status': {
          const projects = state.registry.getAllProjects();
          process.stderr.write(`  exec mode: ${state.execMode}\n`);
          process.stderr.write(`  projects: ${projects.length}\n`);
          for (const p of projects) {
            process.stderr.write(`    ${p.projectName} (${p.projectSlug}) at ${p.directory}\n`);
          }
          process.stderr.write(`  rules: ${ruleStore?.listRules().filter(r => r.enabled).length ?? 'unavailable'} active\n`);
          break;
        }

        case '/gates': {
          const slug = state.registry.getDefaultProject();
          if (!slug) { process.stderr.write('No project registered.\n'); break; }
          const gates = gateManager.getGateStates(slug);
          for (const g of gates) {
            const st = g.open ? 'OPEN' : 'closed';
            const exp = g.expiresAt ? ` (expires ${new Date(g.expiresAt).toLocaleTimeString()})` : '';
            process.stderr.write(`  ${g.gate.padEnd(8)} ${st.padEnd(8)} policy: ${g.policy}${exp}\n`);
          }
          break;
        }

        case '/approve': {
          const gate = args[0] as GateType;
          const duration = parseInt(args[1] || '300', 10);
          const slug = state.registry.getDefaultProject();
          if (!gate || !slug) { process.stderr.write('Usage: /approve <gate> [duration-seconds]\n'); break; }
          if (!VALID_GATES.has(gate)) { process.stderr.write(`Invalid gate: ${gate}. Valid: ${[...VALID_GATES].join(', ')}\n`); break; }
          if (isNaN(duration) || duration < 0) { process.stderr.write('Duration must be a positive number.\n'); break; }

          const payload = gateApprovePayload(gate, slug, duration);
          const sig = await signOperatorAction(operatorKey, payload);
          const ok = await gateManager.approveGate(gate, slug, duration, sig.signature, sig.timestamp);
          if (ok) {
            logger.security('gate_approved_repl', `Gate ${gate} approved (${duration}s)`, { project: slug });
            process.stderr.write(`✓ ${gate} gate opened for ${duration}s (operator-signed)\n`);
          } else {
            process.stderr.write(`✗ Failed to approve gate\n`);
          }
          break;
        }

        case '/deny': {
          const gate = args[0] as GateType;
          const slug = state.registry.getDefaultProject();
          if (!gate || !slug) { process.stderr.write('Usage: /deny <gate>\n'); break; }
          if (!VALID_GATES.has(gate)) { process.stderr.write(`Invalid gate: ${gate}. Valid: ${[...VALID_GATES].join(', ')}\n`); break; }

          const payload = gateDenyPayload(gate, slug);
          const sig = await signOperatorAction(operatorKey, payload);
          const ok = await gateManager.denyGate(gate, slug, sig.signature, sig.timestamp);
          if (ok) {
            logger.security('gate_denied_repl', `Gate ${gate} denied`, { project: slug });
            process.stderr.write(`✗ ${gate} gate denied\n`);
          }
          break;
        }

        case '/secrets': {
          const slug = state.registry.getDefaultProject();
          if (!slug) { process.stderr.write('No project.\n'); break; }
          const store = getSecretStore(state, slug);
          if (!store) { process.stderr.write('No secret store.\n'); break; }

          if (args[0] === 'list') {
            const names = store.list();
            process.stderr.write(`Secrets (${names.length}): ${names.join(', ') || 'none'}\n`);
          } else if (args[0] === 'set' && args[1] && args[2]) {
            store.set(args[1], args.slice(2).join(' '));
            reloadSecretEntries(state);
            process.stderr.write(`✓ Secret "${args[1]}" stored\n`);
          } else if (args[0] === 'reveal' && args[1]) {
            const revealPayload = secretRevealPayload(args[1], slug);
            const sig = await signOperatorAction(operatorKey, revealPayload);
            const valid = await verifyOperatorSignature(operatorKey.publicKeyBase64, revealPayload, sig.signature, sig.timestamp);
            if (!valid) { process.stderr.write('Internal error: operator signature verification failed\n'); break; }

            const val = store.get(args[1]);
            if (val) {
              process.stderr.write(`${args[1]}=${val}\n`);
              logger.security('secret_revealed', `Secret "${args[1]}" revealed (operator-signed)`, { project: slug });
              state.audit.record('secret_revealed', 'operator', { project: slug, details: { name: args[1] } });
            } else {
              process.stderr.write(`Secret "${args[1]}" not found\n`);
            }
          } else {
            process.stderr.write('Usage: /secrets list | /secrets set <n> <v> | /secrets reveal <n>\n');
          }
          break;
        }

        case '/rules': {
          if (!ruleStore) { process.stderr.write('Rule store unavailable (degraded mode).\n'); break; }
          if (!args[0] || args[0] === 'list') {
            for (const r of ruleStore.listRules()) {
              const en = r.enabled ? 'active' : 'disabled';
              const lk = r.locked ? ' [locked]' : '';
              process.stderr.write(`  ${r.id} (${en}${lk}): ${r.message.slice(0, 60)}\n`);
            }
          } else if (args[0] === 'proposals') {
            const proposals = ruleStore.listPendingProposals();
            if (proposals.length === 0) { process.stderr.write('No pending proposals.\n'); break; }
            for (const p of proposals) {
              process.stderr.write(`  ${p.id} [${p.action}] ${p.reason}\n`);
            }
          } else if (args[0] === 'approve' && args[1]) {
            try {
              ruleStore.approveProposal(args[1]);
              logger.security('rule_approved_repl', `Proposal ${args[1]} approved`, {});
              process.stderr.write(`✓ Proposal ${args[1]} approved and materialized\n`);
            } catch (err) { process.stderr.write(`Error: ${(err as Error).message}\n`); }
          } else if (args[0] === 'deny' && args[1]) {
            try {
              ruleStore.denyProposal(args[1]);
              logger.security('rule_denied_repl', `Proposal ${args[1]} denied`, {});
              process.stderr.write(`✗ Proposal ${args[1]} denied\n`);
            } catch (err) { process.stderr.write(`Error: ${(err as Error).message}\n`); }
          } else {
            process.stderr.write('Usage: /rules [list] | /rules proposals | /rules approve <id> | /rules deny <id>\n');
          }
          break;
        }

        case '/scan': {
          const slug = state.registry.getDefaultProject();
          if (!slug) { process.stderr.write('No project.\n'); break; }
          const project = state.registry.getProject(slug)!;
          if (ruleStore) verifyAndRestoreIntegrity(CONFIG_DIR, () => ruleStore!.materializeRules(), (msg) => process.stderr.write(`${msg}\n`));
          const result = scanWorkspace(project.directory, CONFIG_DIR);
          if (result.blocked) {
            process.stderr.write(`BLOCKED (${result.findings.length} findings)\n`);
            for (const f of result.findings) {
              process.stderr.write(`  ${f.file}:${f.line} [${f.rule}] ${f.message.slice(0, 80)}\n`);
            }
          } else {
            process.stderr.write(`CLEAN (${result.files_scanned} files)\n`);
          }
          break;
        }

        case '/exec-mode':
          process.stderr.write(`Exec mode: ${state.execMode}\n`);
          break;

        case '/help':
          process.stderr.write(
            'Commands:\n'
            + '  /status              Daemon + project status\n'
            + '  /gates               Show gate states\n'
            + '  /approve <gate>      Approve gate (operator-signed)\n'
            + '  /deny <gate>         Deny gate\n'
            + '  /secrets list        List secret names\n'
            + '  /secrets set <n> <v> Set secret\n'
            + '  /secrets reveal <n>  Show secret value (stderr)\n'
            + '  /rules [list]        List guardrail rules\n'
            + '  /rules proposals     List pending proposals\n'
            + '  /rules approve <id>  Approve proposal\n'
            + '  /rules deny <id>     Deny proposal\n'
            + '  /scan                Manual guardrail scan\n'
            + '  /exec-mode           Show exec mode\n'
            + '  /quit                Graceful shutdown\n'
            + '  1-4                  Quick gate approval (when prompted)\n',
          );
          break;

        case '/quit':
          process.kill(process.pid, 'SIGTERM');
          break;

        case '1': case '2': case '3': case '4': {
          const pending = gateManager.getPendingRequests();
          if (pending.length === 0) { process.stderr.write('No pending gate request.\n'); break; }
          const req = pending[0];
          const slug = req.project;

          if (cmd === '4') {
            const payload = gateDenyPayload(req.gate, slug);
            const sig = await signOperatorAction(operatorKey, payload);
            await gateManager.denyGate(req.gate, slug, sig.signature, sig.timestamp);
            process.stderr.write(`✗ ${req.gate} denied\n`);
          } else {
            const durations: Record<string, number> = { '1': 300, '2': 0, '3': 86400 };
            const dur = durations[cmd] || 300;
            const payload = gateApprovePayload(req.gate, slug, dur);
            const sig = await signOperatorAction(operatorKey, payload);
            await gateManager.approveGate(req.gate, slug, dur, sig.signature, sig.timestamp);
            const label = cmd === '1' ? '5 min' : cmd === '2' ? 'session' : 'always';
            process.stderr.write(`✓ ${req.gate} approved (${label})\n`);
          }
          break;
        }

        default:
          if (cmd.startsWith('/')) {
            process.stderr.write(`Unknown command: ${cmd}. Type /help for commands.\n`);
          }
      }
    } catch (err) {
      process.stderr.write(`Error: ${(err as Error).message}\n`);
    }

    rl.prompt();
  });

  rl.on('close', () => { process.kill(process.pid, 'SIGTERM'); });
  rl.prompt();
  return rl;
}
