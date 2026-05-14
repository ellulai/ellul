// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Caddy handler integration tests.
 *
 * Runs `caddy validate` and a live proxy against the generated dev-route
 * template, then fires a real HTTP request with a forged Origin header and
 * asserts the upstream saw Origin rewritten to localhost on framework paths
 * and pass-through on user routes.
 *
 * These tests are GATED on the `caddy` binary being available on $PATH. On
 * CI we install caddy; locally they skip if caddy isn't installed (so
 * developers don't fail unrelated tests).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { createServer, type Server, type IncomingMessage } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { generateInitialDevRoute } from './handlers';
import { FRAMEWORK_DEV_PATHS } from '@vps/shared/framework';

const caddyAvailable = (() => {
  try {
    execSync('caddy version', { stdio: 'ignore', timeout: 1000 });
    return true;
  } catch {
    return false;
  }
})();

const maybeDescribe = caddyAvailable ? describe : describe.skip;

maybeDescribe('Caddy dev-route integration', () => {
  let tmpDir: string;
  let caddyfilePath: string;
  let caddyProc: ChildProcess | null = null;
  let upstreamServer: Server;
  let upstreamPort: number;
  const caddyPort = 19080; // unlikely to collide with preview range
  const upstreamRequests: Array<{ path: string; origin: string | undefined; host: string | undefined }> = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-test-'));
    caddyfilePath = path.join(tmpDir, 'Caddyfile');

    // Start a tiny upstream HTTP server that records request headers.
    upstreamServer = createServer((req: IncomingMessage, res) => {
      upstreamRequests.push({
        path: req.url || '',
        origin: req.headers.origin as string | undefined,
        host: req.headers.host as string | undefined,
      });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    });
    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = upstreamServer.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to bind upstream');
    upstreamPort = addr.port;

    // Wrap the generated dev-route template in a standalone site block that
    // binds to caddyPort (the real thing imports into a wildcard site block).
    const generated = generateInitialDevRoute(
      'testhost.local',
      'https://console.ellul.ai',
    );
    // Substitute PREVIEW_PORT_MIN with our upstream port, and wrap in a site
    // block. We deliberately test with our upstream port so we observe
    // Origin rewrites without needing the actual preview orchestrator.
    const testRoute = generated
      .replace(/@dev host testhost\.local/, '@dev host localhost')
      .replace(/127\.0\.0\.1:4000/g, `127.0.0.1:${upstreamPort}`)
      // Origin rewrite also carries the port; swap its hardcoded 4000 too so
      // the assertion against upstreamPort still passes.
      .replace(/"http:\/\/localhost:4000"/g, `"http://localhost:${upstreamPort}"`);

    const caddyfile = `
{
  admin off
  auto_https off
}

:${caddyPort} {
  ${testRoute
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n')}
}
`;
    fs.writeFileSync(caddyfilePath, caddyfile);

    // Validate syntax first — fails fast if our generator produced bad Caddyfile.
    try {
      execSync(`caddy validate --config ${caddyfilePath} --adapter caddyfile`, {
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch (err) {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() || (err as Error).message;
      throw new Error(`caddy validate failed:\n${stderr}\n---\n${caddyfile}`);
    }

    // Start Caddy without the forward_auth shield so we can test pure
    // reverse-proxy + header-rewrite behavior hermetically.
    //
    // The forward_auth block contains Caddy placeholders like `{http.request.
    // header.Cookie}` — a naive regex that stops at the first `}` will match
    // inside the placeholder and leave the rest of the block orphaned. Use
    // brace-balanced stripping instead.
    const stripBlock = (src: string, keyword: string): string => {
      const start = src.indexOf(keyword);
      if (start === -1) return src;
      let i = src.indexOf('{', start);
      if (i === -1) return src;
      let depth = 1;
      i++;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
      }
      return src.slice(0, start) + src.slice(i);
    };
    const caddyfileNoShield = stripBlock(caddyfile, 'forward_auth');
    fs.writeFileSync(caddyfilePath, caddyfileNoShield);

    caddyProc = spawn('caddy', ['run', '--config', caddyfilePath, '--adapter', 'caddyfile'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const caddyStderr: string[] = [];
    caddyProc.stderr!.on('data', (b: Buffer) => caddyStderr.push(b.toString()));
    // Wait up to 5s for Caddy to bind the port.
    const deadline = Date.now() + 5000;
    let bound = false;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://localhost:${caddyPort}/__ping`, { signal: AbortSignal.timeout(200) });
        bound = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!bound) {
      const logs = caddyStderr.join('');
      throw new Error(
        `Caddy failed to bind :${caddyPort} within 5s. Logs:\n${logs}\n---Caddyfile---\n${caddyfileNoShield}`,
      );
    }
  }, 15_000);

  afterAll(async () => {
    if (caddyProc) {
      caddyProc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 200));
      if (!caddyProc.killed) caddyProc.kill('SIGKILL');
    }
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('framework-path request: Origin header rewritten to upstream localhost', async () => {
    upstreamRequests.length = 0;
    const res = await fetch(`http://localhost:${caddyPort}/_next/static/chunks/abc.js`, {
      headers: { Origin: 'https://evil.example.com' },
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(200);
    expect(upstreamRequests.length).toBe(1);
    // The @framework matcher must rewrite Origin to localhost:{upstreamPort}.
    expect(upstreamRequests[0]!.origin).toBe(`http://localhost:${upstreamPort}`);
  });

  it('user app route: Origin header preserved (no rewrite on non-framework paths)', async () => {
    upstreamRequests.length = 0;
    const res = await fetch(`http://localhost:${caddyPort}/api/users`, {
      headers: { Origin: 'https://console.ellul.ai' },
      signal: AbortSignal.timeout(3000),
    });
    expect(res.status).toBe(200);
    expect(upstreamRequests.length).toBe(1);
    // No rewrite — user app's own CSRF check sees the real Origin.
    expect(upstreamRequests[0]!.origin).toBe('https://console.ellul.ai');
  });

  it.each(FRAMEWORK_DEV_PATHS.filter((p) => !p.includes('*')))(
    'framework path %s: Origin rewritten',
    async (frameworkPath) => {
      upstreamRequests.length = 0;
      const res = await fetch(`http://localhost:${caddyPort}${frameworkPath}`, {
        headers: { Origin: 'https://attacker.example.com' },
        signal: AbortSignal.timeout(3000),
      });
      expect(res.status).toBe(200);
      expect(upstreamRequests[0]?.origin).toBe(`http://localhost:${upstreamPort}`);
    },
  );
});

if (!caddyAvailable) {
  describe('Caddy dev-route integration', () => {
    it('SKIPPED: caddy binary not on PATH — install caddy to run these tests', () => {
      expect(true).toBe(true);
    });
  });
}
