// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Build-time PQC Browser Bundle Generator
 *
 * Invoked during `pnpm --filter @ellul.ai/vps build` to produce a pre-built
 * ES module bundle of @noble/post-quantum/ml-kem.js for browser use.
 *
 * The output is written to pqc-mlkem-bundle.ts as a string constant export.
 * This means:
 *   - No esbuild at Cloud Run runtime
 *   - No esbuild on the VPS
 *   - No @noble/post-quantum needed at runtime anywhere
 *   - The bundle is a testable build artifact
 */

import * as esbuild from 'esbuild';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..', '..', '..', '..');

async function main() {
  const result = await esbuild.build({
    stdin: {
      contents: `export { ml_kem1024 } from "@noble/post-quantum/ml-kem.js";`,
      resolveDir: packageRoot,
      loader: 'ts',
    },
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    minify: true,
    write: false,
  });

  const bundleJs = result.outputFiles[0].text;

  const outputPath = path.join(__dirname, 'pqc-mlkem-bundle.ts');
  fs.writeFileSync(outputPath, `// AUTO-GENERATED — do not edit. Run \`pnpm --filter @ellul.ai/vps build\` to regenerate.
// Pre-built browser ES module bundle of @noble/post-quantum/ml-kem.js (minified).
// Used by PoP bind flow (passkey sessions) — served as /_auth/static/pqc-mlkem.js.

export const PQC_MLKEM_BROWSER_BUNDLE = ${JSON.stringify(bundleJs)};
`);

  console.log(`  PQC browser bundle generated (${(bundleJs.length / 1024).toFixed(1)} KB) → pqc-mlkem-bundle.ts`);
}

main().catch((err) => {
  console.error('Failed to generate PQC browser bundle:', err);
  process.exit(1);
});
