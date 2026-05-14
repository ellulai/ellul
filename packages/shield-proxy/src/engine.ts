// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Localhost HTTP proxy → VPS sovereign-shield. Injects session+PoP+STS (via X-Ellul-Project lookup).
// sts_expired 401 → force-refresh + retry once. 127.0.0.1 only; session/PoP never touch disk.

import * as http from 'http';
import { signRequest } from './pop-signer';
import { getVaultHtml } from './vault-html';
import { StreamingRedactionEngine, type SecretEntry } from './streaming-redaction';
import type { IHostEnvironment } from './ports';
import type { StsManager } from './sts-manager';
import type { RedactionMetrics, ConfinementViolation } from './streaming-redaction';

/** VPS error code indicating STS token expired (must match sts.service.ts). */
const STS_EXPIRED_CODE = 'STS_EXPIRED';

// Returns true if handled, false → 404.
export type InternalRequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
) => boolean;

export class AuthProxyEngine {
  private server: http.Server | null = null;
  private port: number = 0;
  private redactionEngine: StreamingRedactionEngine | null = null;
  private stsManager: StsManager | null = null;
  private internalHandler: InternalRequestHandler | null = null;

  constructor(private host: IHostEnvironment) {}

  /**
   * Attach an STS manager for project token injection.
   * Required for any request carrying X-Ellul-Project.
   */
  setStsManager(manager: StsManager): void {
    this.stsManager = manager;
  }

  /**
   * Set a handler for /_internal/* routes.
   * The handler receives (req, res, path) and returns true if it handled the request.
   * If not set or handler returns false, the engine returns 404.
   */
  setInternalHandler(handler: InternalRequestHandler): void {
    this.internalHandler = handler;
  }

  /**
   * Load secrets into the streaming redaction engine.
   * Call this after session establishment and whenever secrets change.
   * The redaction dictionary is held in volatile heap memory only.
   */
  setRedactionSecrets(secrets: SecretEntry[]): void {
    if (this.redactionEngine) {
      this.redactionEngine.updateDictionary(secrets);
    } else {
      this.redactionEngine = new StreamingRedactionEngine(secrets);
    }
    this.host.log(`[auth-proxy] Redaction dictionary loaded: ${secrets.length} secrets, buffer=${this.redactionEngine.getBufferSize()}B`);
  }

  /**
   * Clear the redaction dictionary (e.g. on session teardown).
   */
  clearRedactionSecrets(): void {
    this.redactionEngine = null;
  }

  /**
   * Start the proxy server on a random localhost port.
   * Returns the port number.
   */
  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          this.host.log(`[auth-proxy] Listening on 127.0.0.1:${this.port}`);
          resolve(this.port);
        } else {
          reject(new Error('Failed to bind auth proxy'));
        }
      });

      this.server.on('error', reject);
    });
  }

  getPort(): number {
    return this.port;
  }

  getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = req.url || '/';

    // ── Local routes: served by the proxy itself, not forwarded ──
    if (path === '/_vault' || path === '/_vault/') {
      const project = this.host.getProjectConfig();
      const html = getVaultHtml(project?.projectName);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'none'; object-src 'none'; frame-src 'none'",
      });
      res.end(html);
      return;
    }

    // ── Internal daemon routes (served by the proxy, not forwarded to VPS) ──
    // These are consumed by MCP subprocesses for sync coordination.
    if (path.startsWith('/_internal/')) {
      // Delegate to the registered internal handler (set by proxy-daemon.ts).
      if (this.internalHandler && this.internalHandler(req, res, path)) {
        return;
      }
      // No handler registered or handler declined — return 404.
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Fetch session per-request — supports rotation without restart
    const session = await this.host.getAuthSession();
    if (!session) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active session' }));
      return;
    }

    const method = req.method || 'GET';
    const targetUrl = `https://srv.${session.domain}${path}`;

    try {
      // Read request body as Buffer (supports both text and binary payloads)
      let bodyBuffer: Buffer | null = null;
      if (method !== 'GET' && method !== 'HEAD') {
        bodyBuffer = await readBodyBuffer(req);
      }

      // Build headers
      const headers: Record<string, string> = {
        Cookie: `shield_session=${session.sessionId}`,
        Host: `srv.${session.domain}`,
      };

      // Forward content-type and content-length
      if (req.headers['content-type']) {
        headers['Content-Type'] = req.headers['content-type'];
      }
      if (bodyBuffer) {
        headers['Content-Length'] = String(bodyBuffer.length);
      }

      // ── STS Token Injection ──
      // If X-Ellul-Project header is present (from MCP subprocess or CLI tool),
      // look up the project's STS token and inject it. STS is mandatory —
      // requests without a valid token are rejected at the proxy.
      const projectHeader = req.headers['x-ellul-project'] as string | undefined;
      if (projectHeader) {
        if (!this.stsManager) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'STS manager not initialized. Cannot resolve project identity.' }));
          return;
        }
        const stsToken = this.stsManager.getToken(projectHeader);
        if (!stsToken) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `No STS token for project "${projectHeader}". Acquire token first.` }));
          return;
        }
        headers['X-STS-Token'] = stsToken;
      }

      // Add PoP headers for web_locked tier
      if (session.tier !== 'standard' && session.popHmacKey) {
        const popHeaders = signRequest(
          session.popHmacKey,
          method,
          path,
          bodyBuffer,
        );
        Object.assign(headers, popHeaders);
      }

      // Proxy the request
      let upstream: Response;
      try {
        upstream = await fetch(targetUrl, {
          method,
          headers,
          body: bodyBuffer ? new Uint8Array(bodyBuffer) : undefined,
        });
      } catch (fetchErr: unknown) {
        // VPS unreachable — connection refused, DNS failure, timeout, etc.
        // Return a clear 503 instead of crashing or leaking raw error details.
        const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        const isConnectionError = errMsg.includes('ECONNREFUSED') ||
          errMsg.includes('ENOTFOUND') ||
          errMsg.includes('EAI_AGAIN') ||
          errMsg.includes('ETIMEDOUT') ||
          errMsg.includes('ECONNRESET') ||
          errMsg.includes('fetch failed');

        if (isConnectionError) {
          this.host.log(`[auth-proxy] VPS unreachable: ${errMsg}`);
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'VPS unreachable — may be hibernated. Wake from dashboard and retry.',
            code: 'VPS_UNREACHABLE',
          }));
          return;
        }

        // Unknown fetch error — re-throw
        throw fetchErr;
      }

      // ── Gotcha #4: Transparent STS retry on expiry ──
      // If the VPS returns 401 with STS_EXPIRED code, force-refresh the token
      // and retry the request ONCE. This handles the race where a request is
      // in-flight when the STS token crosses the 15-minute boundary.
      if (upstream.status === 401 && projectHeader && this.stsManager) {
        const errorBody = await upstream.text().catch(() => '');
        if (errorBody.includes(STS_EXPIRED_CODE)) {
          this.host.log(`[auth-proxy] STS expired for "${projectHeader}" — force-refreshing and retrying`);
          const newToken = await this.stsManager.forceRefresh(projectHeader);
          if (newToken) {
            headers['X-STS-Token'] = newToken;
            // Re-sign PoP with fresh nonce (PoP nonces are single-use)
            if (session.tier !== 'standard' && session.popHmacKey) {
              const popHeaders = signRequest(
                session.popHmacKey,
                method,
                path,
                bodyBuffer,
              );
              Object.assign(headers, popHeaders);
            }
            upstream = await fetch(targetUrl, {
              method,
              headers,
              body: bodyBuffer ? new Uint8Array(bodyBuffer) : undefined,
            });
            // Don't retry again if this also fails
          }
        } else {
          // Not STS-related 401 — session expired
          this.host.notifyUser('Session expired — re-authenticate to continue.', 'warning');
          // Write the error body we already consumed
          this.writeSimpleResponse(res, 401, errorBody, upstream);
          return;
        }
      }

      // Detect expired session (non-STS 401)
      if (upstream.status === 401) {
        this.host.notifyUser('Session expired — re-authenticate to continue.', 'warning');
      }

      // Stream the response with redaction
      await this.streamResponse(upstream, res);
    } catch (err) {
      this.host.log(`[auth-proxy] Proxy error: ${err}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'Proxy error' }));
    }
  }

  /**
   * Write a simple response when we've already consumed the upstream body.
   */
  private writeSimpleResponse(
    res: http.ServerResponse,
    status: number,
    body: string,
    upstream: Response,
  ): void {
    const resHeaders: Record<string, string> = {};
    const contentType = upstream.headers.get('content-type');
    if (contentType) resHeaders['Content-Type'] = contentType;
    res.writeHead(status, resHeaders);
    res.end(body);
  }

  /**
   * Stream an upstream response to the client with optional redaction.
   */
  private async streamResponse(upstream: Response, res: http.ServerResponse): Promise<void> {
    const redactor = this.redactionEngine?.hasPatterns()
      ? this.redactionEngine.createStreamInstance()
      : null;

    // Forward response headers
    const resHeaders: Record<string, string> = {};
    const contentType = upstream.headers.get('content-type');
    if (contentType) resHeaders['Content-Type'] = contentType;

    for (const name of ['cache-control', 'transfer-encoding']) {
      const val = upstream.headers.get(name);
      if (val) resHeaders[name] = val;
    }
    if (!redactor) {
      const cl = upstream.headers.get('content-length');
      if (cl) resHeaders['content-length'] = cl;
    }

    res.writeHead(upstream.status, resHeaders);

    if (upstream.body) {
      const reader = upstream.body.getReader();
      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read();

        if (done) {
          if (redactor) {
            if (redactor.isHalted()) {
              this.host.log('[auth-proxy] CONFINEMENT VIOLATION: stream halted before flush — credential bytes detected in output');
              res.end();
              return;
            }

            const final = redactor.flush();

            if (redactor.isHalted()) {
              this.host.log('[auth-proxy] CONFINEMENT VIOLATION: credential bytes detected in flush output — stream terminated');
              res.end();
              return;
            }

            if (final.length > 0) {
              const canContinue = res.write(final);
              if (!canContinue) {
                await new Promise<void>((resolve) => res.once('drain', resolve));
              }
            }

            const metrics = redactor.getMetrics();
            if (metrics.matchCount > 0) {
              this.host.log(
                `[auth-proxy] Redaction: ${metrics.matchCount} matches, ` +
                `${metrics.bytesProcessed}B in → ${metrics.bytesEmitted}B out`,
              );
            }
          }
          res.end();
          return;
        }

        const output = redactor
          ? redactor.process(Buffer.from(value))
          : value;

        if (redactor?.isHalted()) {
          this.host.log('[auth-proxy] CONFINEMENT VIOLATION: credential bytes detected in redacted output — stream terminated');
          res.end();
          return;
        }

        if (output.length > 0) {
          const canContinue = res.write(output);
          if (!canContinue) {
            await new Promise<void>((resolve) => res.once('drain', resolve));
          }
        }
        return pump();
      };
      await pump();
    } else {
      res.end();
    }
  }

  /**
   * Get the URL to the secrets vault UI.
   */
  getVaultUrl(): string {
    return `${this.getUrl()}/_vault`;
  }

  dispose(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

/** Max request body size (100MB — matches VPS sync upload limit with headroom). */
const MAX_BODY_SIZE = 100 * 1024 * 1024;

function readBodyBuffer(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
