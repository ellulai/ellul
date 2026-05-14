// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Terminal wrapper initialization script.
 *
 * Loaded by terminal-wrapper.html after session-pop.js.
 * Handles PoP initialization, terminal token acquisition, and iframe embed.
 */

declare const SESSION_POP: {
  initialize(): Promise<boolean>;
  wrapFetch(): void;
};

interface TerminalTokenResponse {
  token: string;
}

interface TerminalErrorResponse {
  error?: string;
  reason?: string;
}

async function getTerminalToken(maxRetries: number = 3): Promise<TerminalTokenResponse> {
  const status = document.getElementById('status')!;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await fetch('/_auth/terminal/authorize', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });

    if (res.ok) {
      return res.json() as Promise<TerminalTokenResponse>;
    }

    const err: TerminalErrorResponse = await res.json().catch(() => ({}));

    if (err.reason === 'pop_not_bound' && attempt < maxRetries) {
      status.textContent = 'Initializing security (' + attempt + '/' + maxRetries + ')...';
      await new Promise<void>((r) => setTimeout(r, 500 * attempt));
      continue;
    }

    throw new Error(err.error || err.reason || 'Authorization failed');
  }
  throw new Error('Authorization failed after retries');
}

(async function () {
  const status = document.getElementById('status')!;
  const loading = document.getElementById('loading')!;
  const terminal = document.getElementById('terminal') as HTMLIFrameElement;

  try {
    if (typeof SESSION_POP !== 'undefined') {
      status.textContent = 'Initializing security...';
      try {
        await SESSION_POP.initialize();
        SESSION_POP.wrapFetch();
      } catch (_) { /* PoP init failure is non-fatal here — token fetch will retry */ }
    }

    status.textContent = 'Getting authorization...';
    const { token } = await getTerminalToken();
    status.textContent = 'Loading terminal...';

    const wrapperParams = new URLSearchParams(window.location.search);
    const path = wrapperParams.get('target') || window.location.pathname;
    const params = new URLSearchParams();
    params.set('_term_token', token);
    params.set('_embedded', '1');

    const separator = path.includes('?') ? '&' : '?';
    terminal.src = path + separator + params.toString();
    terminal.onload = function () {
      loading.style.display = 'none';
      terminal.style.display = 'block';
      try {
        // Suppress noisy [ttyd] console output from iframe
        const cw = terminal.contentWindow as Window & typeof globalThis | null;
        if (cw) {
          const origLog = cw.console.log.bind(cw.console);
          const origWarn = cw.console.warn.bind(cw.console);
          cw.console.log = function (...args: unknown[]) {
            if (typeof args[0] === 'string' && args[0].startsWith('[ttyd]')) return;
            origLog(...args);
          };
          cw.console.warn = function (...args: unknown[]) {
            if (typeof args[0] === 'string' && args[0].startsWith('[ttyd]')) return;
            origWarn(...args);
          };
        }
      } catch (_) { /* cross-origin iframe — expected */ }
    };

    // Fallback: force-show terminal after 3s even if onload hasn't fired
    setTimeout(() => {
      if (loading.style.display !== 'none') {
        loading.style.display = 'none';
        terminal.style.display = 'block';
      }
    }, 3000);
  } catch (e) {
    console.error('Terminal auth error:', e);
    status.className = 'error';
    status.textContent = (e as Error).message || 'Authorization failed. Please refresh.';
    document.querySelector<HTMLElement>('.spinner')!.style.display = 'none';
  }
})();
