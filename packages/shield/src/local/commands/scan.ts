// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul scan — Manual guardrail scan of current workspace
 */

import * as path from 'path';
import { scanWorkspace, resolveGuardrailBinary } from '../index';

const CONFIG_DIR = path.join(process.env.HOME || '~', '.ellul');

export async function handleScan(): Promise<void> {
  const binary = resolveGuardrailBinary();
  if (!binary) {
    process.stderr.write('Error: Guardrail binary not found. Install at ~/.ellul/bin/guardrail\n');
    process.exit(1);
  }

  process.stderr.write(`Scanning ${process.cwd()}...\n`);
  const result = scanWorkspace(process.cwd(), CONFIG_DIR);

  if (result.error) {
    process.stderr.write(`Error: ${result.error}\n`);
  }

  if (result.findings.length > 0) {
    process.stderr.write(`\nFindings (${result.findings.length}):\n`);
    for (const f of result.findings) {
      const severity = f.severity === 0 ? 'ERROR' : 'WARN';
      process.stderr.write(`  ${severity} ${f.file}:${f.line}:${f.column} [${f.rule}]\n`);
      process.stderr.write(`    ${f.message}\n\n`);
    }
  }

  process.stderr.write(`Files scanned: ${result.files_scanned}\n`);

  if (result.blocked) {
    process.stderr.write('Result: BLOCKED\n');
    process.exit(1);
  } else {
    process.stderr.write('Result: CLEAN\n');
  }
}
