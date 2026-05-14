// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * service-builder.ts -- Node.js service rebuild logic (esbuild bundling).
 */

import * as fs from 'fs';
import * as path from 'path';

import type { VpsConfig } from './config';
import { REPO_DIR } from './config';

// ─── VPS-UI resolver plugin for on-VPS esbuild ─────────────────────
// Resolves @ellul.ai/vps-ui/* imports from pre-deployed HTML files
// at /opt/ellul/ui/ (written during provisioning/updates)

const VPS_UI_DIR = path.join(REPO_DIR, 'ui');

function vpsUiPlugin() {
  return {
    name: 'vps-ui-resolver',
    setup(build: any) {
      build.onResolve({ filter: /^@ellul\.ai\/vps-ui\// }, (args: any) => {
        const name = args.path.replace('@ellul.ai/vps-ui/', '');
        const htmlPath = path.join(VPS_UI_DIR, `${name}.html`);
        if (fs.existsSync(htmlPath)) {
          return { path: htmlPath, namespace: 'vps-ui-html' };
        }
        console.warn(`[rebuild-all] vps-ui: ${name}.html not found at ${htmlPath}`);
        return undefined;
      });
      build.onLoad({ filter: /.*/, namespace: 'vps-ui-html' }, (args: any) => {
        const html = fs.readFileSync(args.path, 'utf8');
        return {
          contents: `module.exports = ${JSON.stringify(html)};`,
          loader: 'js',
        };
      });
    },
  };
}

// ─── Node.js service rebuilds ───────────────────────────────────────

export async function rebuildNodeServices(config: VpsConfig): Promise<number> {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch {
    console.log('[rebuild-all] esbuild not available, skipping Node.js service rebuilds');
    return 0;
  }

  const NODE_EXTERNALS = [
    'fs', 'path', 'crypto', 'http', 'https', 'url',
    'events', 'stream', 'util', 'os', 'child_process',
  ];

  const services = [
    {
      name: 'sovereign-shield',
      entry: path.join(REPO_DIR, 'src/services/auth/sovereign-shield/src/main.ts'),
      out: path.join(REPO_DIR, 'auth/server.js'),
      banner: `process.env.ELLUL_HOSTNAME = ${JSON.stringify(config.domain)};`,
      external: [...NODE_EXTERNALS, 'hono', '@hono/node-server', 'better-sqlite3', '@simplewebauthn/server'],
    },
    {
      name: 'file-api',
      entry: path.join(REPO_DIR, 'src/services/backends/file-api/src/main.ts'),
      out: '/usr/local/bin/ellul-file-api',
      banner: `process.env.ELLUL_SERVER_ID = ${JSON.stringify(config.serverId)};`,
      external: [...NODE_EXTERNALS, 'ws', 'chokidar'],
    },
    {
      name: 'agent-bridge',
      entry: path.join(REPO_DIR, 'src/services/backends/agent-bridge/src/main.ts'),
      out: '/usr/local/bin/ellul-agent-bridge',
      banner: '',
      external: [...NODE_EXTERNALS, 'ws', 'node-pty', 'better-sqlite3', 'isolated-vm'],
    },
  ];

  let rebuilt = 0;
  for (const svc of services) {
    if (!fs.existsSync(svc.entry)) {
      console.log(`[rebuild-all] SKIP ${svc.name}: entry not found at ${svc.entry}`);
      continue;
    }
    try {
      const result = await esbuild.build({
        entryPoints: [svc.entry],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        write: false,
        external: svc.external,
        tsconfig: path.join(REPO_DIR, 'tsconfig.json'),
        plugins: [vpsUiPlugin()],
      });

      const code = (svc.banner ? svc.banner + '\n' : '') + result.outputFiles[0].text;
      const tmp = svc.out + '.rebuild-tmp';
      fs.writeFileSync(tmp, code);
      fs.renameSync(tmp, svc.out);
      if (svc.out.startsWith('/usr/local/bin/')) {
        fs.chmodSync(svc.out, 0o755);
      }
      console.log(`[rebuild-all] Rebuilt ${svc.name}`);
      rebuilt++;
    } catch (err) {
      console.error(`[rebuild-all] FAILED to rebuild ${svc.name}: ${err}`);
    }
  }

  return rebuilt;
}
