// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul secrets — Local encrypted secret management
 *
 * Commands:
 *   ellul secrets set <name> <value>   Encrypt + store
 *   ellul secrets set <name> --stdin   Read value from stdin (no shell history)
 *   ellul secrets list                 List names only (no values)
 *   ellul secrets import <file>        Parse .env, bulk encrypt
 *   ellul secrets reveal <name>        Decrypt + print ONE secret to stderr
 *   ellul secrets delete <name>        Delete secret
 *
 * No export/dump command by design — secrets leave daemon memory only as
 * redaction patterns, exec env vars, or operator-signed single-value reveal.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { LocalSecretStore, initMasterSecret, deriveKeys } from '../index';

function getProjectSecretsDb(): string | null {
  const projectFile = path.join(process.cwd(), '.ellul', 'project.json');
  if (!fs.existsSync(projectFile)) return null;
  return path.join(process.cwd(), '.ellul', 'secrets.db');
}

function openStore(): LocalSecretStore | null {
  const dbPath = getProjectSecretsDb();
  if (!dbPath) {
    process.stderr.write('Error: No project bound in cwd. Run: ellul init\n');
    return null;
  }

  const log = (msg: string) => process.stderr.write(`${msg}\n`);
  const master = initMasterSecret(log);
  const keys = deriveKeys(master);
  return new LocalSecretStore(dbPath, keys.secretsEncKey);
}

export async function handleSecrets(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'set': {
      const name = args[1];
      if (!name) {
        process.stderr.write('Usage: ellul secrets set <name> <value|--stdin>\n');
        process.exit(1);
      }

      let value: string;
      if (args[2] === '--stdin') {
        // Read from stdin (safe for piping, no shell history)
        const rl = readline.createInterface({ input: process.stdin });
        const lines: string[] = [];
        for await (const line of rl) { lines.push(line); }
        value = lines.join('\n');
      } else if (args[2]) {
        value = args.slice(2).join(' ');
      } else {
        process.stderr.write('Usage: ellul secrets set <name> <value|--stdin>\n');
        process.exit(1);
        return;
      }

      const store = openStore();
      if (!store) return;
      store.set(name, value);
      store.close();
      process.stderr.write(`✓ Secret "${name}" stored (encrypted)\n`);
      break;
    }

    case 'list': {
      const store = openStore();
      if (!store) return;
      const names = store.list();
      store.close();

      if (names.length === 0) {
        process.stderr.write('No secrets stored. Use: ellul secrets set <name> <value>\n');
      } else {
        process.stderr.write(`Secrets (${names.length}):\n`);
        for (const name of names) {
          process.stderr.write(`  ${name}\n`);
        }
      }
      break;
    }

    case 'import': {
      const file = args[1];
      if (!file) {
        process.stderr.write('Usage: ellul secrets import <file.env>\n');
        process.exit(1);
      }

      if (!fs.existsSync(file)) {
        process.stderr.write(`Error: File not found: ${file}\n`);
        process.exit(1);
      }

      const content = fs.readFileSync(file, 'utf8');
      const store = openStore();
      if (!store) return;
      const count = store.importEnv(content);
      store.close();

      process.stderr.write(`✓ Imported ${count} secret(s) from ${file}\n`);

      // Prompt to delete source file
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const answer = await new Promise<string>((resolve) => {
        rl.question('Delete source file? [Y/n] ', resolve);
      });
      rl.close();

      if (!answer || answer.toLowerCase() === 'y') {
        fs.unlinkSync(file);
        process.stderr.write(`✓ Deleted ${file}\n`);
      }
      break;
    }

    case 'reveal': {
      const name = args[1];
      if (!name) {
        process.stderr.write('Usage: ellul secrets reveal <name>\n');
        process.exit(1);
      }

      const store = openStore();
      if (!store) return;
      const value = store.get(name);
      store.close();

      if (value === null) {
        process.stderr.write(`Error: Secret "${name}" not found\n`);
        process.exit(1);
      }

      // Print to stderr only (never stdout)
      process.stderr.write(`${name}=${value}\n`);
      break;
    }

    case 'delete': {
      const name = args[1];
      if (!name) {
        process.stderr.write('Usage: ellul secrets delete <name>\n');
        process.exit(1);
      }

      const store = openStore();
      if (!store) return;
      const deleted = store.delete(name);
      store.close();

      if (deleted) {
        process.stderr.write(`✓ Secret "${name}" deleted\n`);
      } else {
        process.stderr.write(`Secret "${name}" not found\n`);
      }
      break;
    }

    default:
      process.stderr.write(
        'Usage: ellul secrets <set|list|import|reveal|delete>\n\n' +
        '  set <name> <value>     Encrypt + store a secret\n' +
        '  set <name> --stdin     Read value from stdin\n' +
        '  list                   List secret names (no values)\n' +
        '  import <file>          Import from .env file\n' +
        '  reveal <name>          Show one secret (stderr only)\n' +
        '  delete <name>          Delete a secret\n',
      );
      if (subcommand) process.exit(1);
  }
}
