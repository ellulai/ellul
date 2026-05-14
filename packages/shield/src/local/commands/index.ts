// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Local-mode command handler
 *
 * Dispatches subcommands for the free-tier local governance product.
 * Imported dynamically by the unified CLI entry point (cloud/index.ts)
 * to avoid loading local dependencies (better-sqlite3, etc.) for cloud users.
 *
 * Commands:
 *   (default)                   Start daemon (foreground + REPL)
 *   start --detach              Start daemon in background
 *   stop                        Stop running daemon
 *   init [name]                 Initialize project in cwd
 *   rebind                      Rebind workspace after move
 *   status                      Daemon + project status
 *   secrets <sub>               Secret management
 *   gates <sub>                 Gate management
 *   rules <sub>                 Guardrail rule management
 *   scan                        Manual guardrail scan
 *   doctor                      Health diagnostics
 *   env                         Print socket path for eval
 */

import * as fs from 'fs';
import * as path from 'path';

const CONFIG_DIR = path.join(process.env.HOME || '~', '.ellul');
const SOCKET_PATH = path.join(CONFIG_DIR, 'daemon.sock');

/**
 * Route a local-mode command.
 * @param args Raw argv tail — everything after 'ellul' (e.g. ['secrets', 'set', 'FOO', 'bar'])
 */
export async function handleLocalCommand(args: string[]): Promise<void> {
  const command = args[0] || '';

  switch (command) {
    case '':
    case 'start': {
      const detach = args.includes('--detach') || args.includes('-d');
      if (detach) {
        // Background mode: spawn detached child
        const { spawn } = await import('child_process');
        const child = spawn(process.execPath, [__filename], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, ELLUL_DAEMON_DETACHED: '1' },
        });
        child.unref();
        process.stderr.write(`Daemon started in background (PID ${child.pid})\n`);
        return;
      }

      // Foreground mode: start daemon
      const { startLocalDaemon } = await import('../index');
      await startLocalDaemon();
      // Daemon runs until SIGTERM/SIGINT — keep the process alive
      // The daemon's REPL handles user interaction on stdin
      break;
    }

    case 'stop': {
      const pidFile = path.join(CONFIG_DIR, 'daemon.pid');
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        try {
          process.kill(pid, 'SIGTERM');
          process.stderr.write(`Sent SIGTERM to daemon (PID ${pid})\n`);
        } catch {
          process.stderr.write(`Daemon (PID ${pid}) not running. Cleaning up.\n`);
          try { fs.unlinkSync(pidFile); } catch {}
          try { fs.unlinkSync(SOCKET_PATH); } catch {}
        }
      } else if (fs.existsSync(SOCKET_PATH)) {
        process.stderr.write('No PID file found. Removing stale socket.\n');
        try { fs.unlinkSync(SOCKET_PATH); } catch {}
      } else {
        process.stderr.write('Daemon not running.\n');
      }
      break;
    }

    case 'init': {
      const { handleLocalInit } = await import('./init');
      await handleLocalInit(args.slice(1));
      break;
    }

    case 'rebind': {
      const { handleRebind } = await import('./rebind');
      await handleRebind();
      break;
    }

    case 'status': {
      if (!fs.existsSync(SOCKET_PATH)) {
        process.stderr.write('Daemon not running.\n');
        process.exit(1);
      }
      const http = await import('http');
      const result = await new Promise<string>((resolve, reject) => {
        const req = http.request({ socketPath: SOCKET_PATH, method: 'GET', path: '/_local/status' }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.end();
      });
      try {
        const status = JSON.parse(result);
        process.stderr.write(`ellul daemon v${status.version} — ${status.mode} mode\n`);
        process.stderr.write(`  uptime: ${Math.round(status.uptime)}s\n`);
        process.stderr.write(`  ipc: ${status.ipc}\n`);
        process.stderr.write(`  peercred: ${status.peercredTier}\n`);
        if (status.projects?.length > 0) {
          for (const p of status.projects) {
            process.stderr.write(`  project: ${p.name} (${p.slug})\n`);
            process.stderr.write(`    dir: ${p.directory}\n`);
            process.stderr.write(`    fpr: ${p.fingerprint?.slice(0, 16)}...\n`);
          }
        } else {
          process.stderr.write('  projects: none\n');
        }
      } catch {
        process.stderr.write(result + '\n');
      }
      break;
    }

    case 'secrets': {
      const { handleSecrets } = await import('./secrets');
      await handleSecrets(args.slice(1));
      break;
    }

    case 'gates': {
      const { handleGates } = await import('./gates');
      await handleGates(args.slice(1));
      break;
    }

    case 'rules': {
      const { handleRules } = await import('./rules');
      await handleRules(args.slice(1));
      break;
    }

    case 'scan': {
      const { handleScan } = await import('./scan');
      await handleScan();
      break;
    }

    case 'doctor': {
      const { runDoctor } = await import('./doctor');
      await runDoctor();
      break;
    }

    case 'upgrade': {
      const { handleUpgrade } = await import('./upgrade');
      await handleUpgrade();
      break;
    }

    case 'downgrade': {
      const { handleDowngrade } = await import('./downgrade');
      await handleDowngrade();
      break;
    }

    case 'env': {
      // Print eval-able environment setup
      if (fs.existsSync(SOCKET_PATH)) {
        process.stdout.write(`export ELLUL_SOCKET="${SOCKET_PATH}"\n`);
      } else {
        // Check TCP fallback
        const portFile = path.join(CONFIG_DIR, 'proxy.port');
        if (fs.existsSync(portFile)) {
          const raw = fs.readFileSync(portFile, 'utf8').trim();
          const port = raw.split(':')[0];
          process.stdout.write(`export ELLUL_PROXY="http://127.0.0.1:${port}"\n`);
        } else {
          process.stderr.write('Daemon not running.\n');
          process.exit(1);
        }
      }
      break;
    }

    case 'help':
    case '--help':
    case '-h': {
      process.stderr.write(
        'ellul — Local AI governance daemon + CLI\n\n' +
        'Usage: ellul [command]\n\n' +
        'Commands:\n' +
        '  (default)          Start daemon with interactive REPL\n' +
        '  start --detach     Start daemon in background\n' +
        '  stop               Stop running daemon\n' +
        '  init [name]        Initialize project in current directory\n' +
        '  rebind             Rebind workspace after moving directory\n' +
        '  status             Show daemon and project status\n' +
        '  secrets <sub>      Manage encrypted secrets (set|list|import|reveal|delete)\n' +
        '  gates <sub>        Manage execution gates (status|approve|deny)\n' +
        '  rules <sub>        Manage guardrail rules (list|add|proposals|approve|deny)\n' +
        '  scan               Run guardrail scan on current workspace\n' +
        '  doctor             Run health diagnostics\n' +
        '  env                Print eval-able socket/proxy URL\n' +
        '  help               Show this help\n',
      );
      break;
    }

    default:
      process.stderr.write(`Unknown command: ${command}\nRun 'ellul help' for usage.\n`);
      process.exit(1);
  }
}

// No standalone entry — the unified CLI (cloud/index.ts) imports
// handleLocalCommand() and routes to it after mode verification.
// The ellul-local bin entry now points to the unified CLI.
