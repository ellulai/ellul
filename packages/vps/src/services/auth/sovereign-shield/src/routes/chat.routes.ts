// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Chat Routes
 *
 * Serves the VPS-side chat SPA from /_auth/chat.
 * The SPA runs same-origin — authenticates via shield_session cookie (web_locked)
 * or JWT cookie (standard). The platform never sees agent tokens.
 *
 * Security:
 * - Auth enforced by tier-gate middleware (session required before serving HTML)
 * - CSP with frame-ancestors prevents framing from unauthorized origins
 * - no-store prevents caching of authenticated content
 * - session-pop.js injected for WebSocket PoP challenge-response
 */

import { promises as fsp, constants as fsConstants } from 'fs';
import type { Hono } from 'hono';
import chatHtml from '@ellul.ai/vps-ui/chat';
import { ALL_LOCALES, DEFAULT_LOCALE } from '@ellul.ai/i18n-consts/locales';
import { readSettings, applyTierOverrides } from '../application/platform/Settings';
import { CONSOLE_ORIGIN } from '../config';

/**
 * Locales the VPS UI knows how to render — single source of truth in
 * `@ellul.ai/i18n-consts`. The `/locales` subpath is zero-dep pure
 * data + helpers, so importing it adds no transitive runtime weight
 * to the shield bundle.
 */
const SUPPORTED_LOCALES = new Set<string>(ALL_LOCALES);

/**
 * Locale source for VPS-served UIs.
 *
 * The console embeds the chat iframe with `?locale=<value>` derived from
 * `session.user.preferredLocale` (api DB authoritative). The VPS reads the
 * query param at HTML-serve time and injects into `__SHIELD_SETTINGS__`.
 *
 * Drift-bounded by request lifetime — the api DB is the source of truth;
 * the VPS holds nothing. Mid-session changes propagate via `set_locale`
 * postMessage (see vps-ui IntlRoot).
 */
function resolveLocale(c: { req: { query: (k: string) => string | undefined } }): string {
  const raw = c.req.query('locale');
  if (raw && SUPPORTED_LOCALES.has(raw)) return raw;
  return DEFAULT_LOCALE;
}

/**
 * Locale intent file — written here, consumed by the enforcer (root) which
 * mirrors it into /etc/ellul/user-locale and /etc/environment LANG/LC_ALL.
 *
 * shield-data is shield-runner:shield-runner 700 (see provisioning's
 * directories.ts), so this file is invisible to the agent's $SVC_USER and
 * still readable by the root enforcer. Filesystem mediation preserves the
 * Phase 4 one-way heartbeat invariant: the API never injects locale state
 * into the VPS — only sovereign-shield's own validated query-param decision
 * gets persisted.
 *
 * Hardening:
 * - All filesystem ops use `O_NOFOLLOW` so a symlink planted at the path
 *   (only possible from inside shield-runner, but defense-in-depth) is
 *   refused with `ELOOP` rather than followed.
 * - Async I/O (fs.promises) so the chat HTML serve never blocks on disk.
 * - Atomic write via tmp + rename so the enforcer reading concurrently
 *   never sees a partial value.
 * - Caller invokes via `void syncLocaleIntent(...).catch(...)` so the
 *   response returns immediately; the next heartbeat tick (~10s) picks
 *   up the value either way.
 */
const SHIELD_LOCALE_INTENT_FILE = '/etc/ellul/shield-data/user-locale';

async function syncLocaleIntent(locale: string): Promise<void> {
  let current: string | null = null;
  try {
    const fh = await fsp.open(
      SHIELD_LOCALE_INTENT_FILE,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      current = (await fh.readFile('utf8')).trim();
    } finally {
      await fh.close();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT (first write), ELOOP (symlink at path — refuse to follow),
    // EACCES, etc. — fall through. ELOOP path also short-circuits the
    // write below since we don't want to clobber a hostile symlink.
    if (code === 'ELOOP') return;
  }

  if (current === locale) return;

  const tmpPath = `${SHIELD_LOCALE_INTENT_FILE}.tmp.${process.pid}.${Date.now()}`;
  try {
    const fh = await fsp.open(
      tmpPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o644,
    );
    try {
      await fh.writeFile(`${locale}\n`, 'utf8');
    } finally {
      await fh.close();
    }
    // rename(2) replaces the destination atomically and does NOT follow
    // a symlink at the destination — it removes the symlink and replaces.
    await fsp.rename(tmpPath, SHIELD_LOCALE_INTENT_FILE);
  } catch {
    // Cleanup the tmp file on any failure; ignore unlink errors. The
    // next chat HTML serve will retry, and the heartbeat reconciler is
    // a no-op when intent === current.
    await fsp.unlink(tmpPath).catch(() => undefined);
  }
}

export function registerChatRoutes(app: Hono): void {
  app.get('/_auth/chat', (c) => {
    // Inject session-pop.js before the first <script> in the SPA
    // This makes SESSION_POP available for WebSocket PoP challenge-response
    let html = chatHtml;
    const popScript = `<script src="/_auth/static/session-pop.js"></script>`;

    // Inject settings so VPS UI has them synchronously on load (no flash)
    const settings = applyTierOverrides(readSettings());
    const locale = resolveLocale(c);
    // Persist the locale intent so the enforcer can mirror it into
    // /etc/ellul/user-locale + /etc/environment on its next heartbeat.
    // Fire-and-forget — never block the HTML serve on disk I/O. Errors
    // are swallowed inside syncLocaleIntent; the heartbeat tick is the
    // eventual-consistency channel either way.
    void syncLocaleIntent(locale).catch(() => undefined);
    const settingsScript = `<script>window.__SHIELD_SETTINGS__=${JSON.stringify({
      desktopViewMode: settings.desktopViewMode,
      uiMode: settings.uiMode,
      locale,
    })};</script>`;

    html = html.replace('<script', popScript + settingsScript + '<script');

    // NOTE: Nonce-based CSP is NOT compatible with pre-built SPA bundles because
    // bundled JS contains string literals like innerHTML="<script>" which regex
    // nonce injection corrupts. Use 'unsafe-inline' for script/style — the real
    // protection is frame-ancestors + auth cookies + PoP challenge-response.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self' wss:",
      `frame-ancestors 'self' ${CONSOLE_ORIGIN}`,
      "base-uri 'self'",
      "form-action 'none'",
      "object-src 'none'",
    ].join('; ');

    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('Content-Security-Policy', csp);
    c.header('Cache-Control', 'no-store');
    return c.body(html);
  });
}
