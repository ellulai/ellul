// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Shared Browser Callback Utilities
 *
 * Extracted from login.ts for reuse across CLI commands that need
 * browser-based OAuth/auth flows (login, git connect, etc.)
 */

import * as crypto from 'crypto';
import * as http from 'http';
import { spawnSync } from 'child_process';

/** Escape HTML special chars to prevent XSS in callback success page. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Open a URL in the user's default browser.
 * Falls back to printing the URL if browser open fails.
 */
export function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const result = spawnSync(cmd, [url], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    process.stderr.write(
      `Could not open browser automatically.\n` +
      `Please open this URL manually:\n\n  ${url}\n\n`,
    );
  }
}

export interface CallbackResult {
  /** Query params from the callback URL */
  params: URLSearchParams;
  nonce: string;
}

/**
 * Create callback HTTP server bound to 127.0.0.1 on a random port.
 * Returns the server, its port, and a promise that resolves when a valid
 * callback is received (or rejects on timeout/error).
 *
 * The callback URL must include a `nonce` query param matching expectedNonce.
 * All other query params are returned in the result.
 */
export function createCallbackServer(
  expectedNonce: string,
  signal: AbortSignal,
  opts?: {
    successTitle?: string;
    successMessage?: string;
  },
): { server: http.Server; port: number; resultPromise: Promise<CallbackResult> } {
  let resolveResult!: (result: CallbackResult) => void;
  let rejectResult!: (err: Error) => void;

  const resultPromise = new Promise<CallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const title = opts?.successTitle ?? 'Success';
  const message = opts?.successMessage ?? 'You can close this tab and return to the terminal.';

  const server = http.createServer((req, res) => {
    // Only accept connections from localhost
    const remoteAddr = req.socket.remoteAddress;
    if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Reject oversized URLs (prevent OOM via crafted query strings)
    if ((req.url?.length ?? 0) > 4096) {
      res.writeHead(414);
      res.end('URI too long');
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const nonce = url.searchParams.get('nonce');

    if (!nonce) {
      res.writeHead(400);
      res.end('Missing nonce parameter.');
      return;
    }

    if (nonce.length !== expectedNonce.length ||
        !crypto.timingSafeEqual(Buffer.from(nonce), Buffer.from(expectedNonce))) {
      res.writeHead(403);
      res.end('Nonce mismatch — possible CSRF attack. Aborted.');
      return;
    }

    // Send success page to browser
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px">' +
      `<h2>${escapeHtml(title)}</h2>` +
      `<p>${escapeHtml(message)}</p>` +
      '</body></html>',
    );

    server.close();
    resolveResult({ params: url.searchParams, nonce });
  });

  // Bind to 127.0.0.1 only — prevents external connections
  server.listen(0, '127.0.0.1');
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;

  if (port === 0) {
    server.close();
    throw new Error('Failed to bind callback server to a local port.');
  }

  // Abort handler for timeout
  const onAbort = () => {
    server.close();
    rejectResult(new Error('Timed out — no callback received within 5 minutes.'));
  };

  if (signal.aborted) {
    server.close();
    throw new Error('Timed out — no callback received within 5 minutes.');
  }
  signal.addEventListener('abort', onAbort, { once: true });

  server.on('error', (err) => {
    rejectResult(new Error(`Callback server failed: ${err.message}`));
  });

  return { server, port, resultPromise };
}
