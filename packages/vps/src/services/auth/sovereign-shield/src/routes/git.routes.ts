// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Git Authorization Routes
 *
 * Passkey-protected git repo linking for Web Locked tier.
 * Prevents a compromised API from linking malicious repos without user verification.
 *
 * Endpoints:
 * - POST /_auth/git/authorize-link     - Authorize git link (requires passkey session + PoP)
 * - POST /_auth/git/verify-link-token  - Verify link token (called by platform API)
 * - POST /_auth/git/authorize-unlink   - Authorize git unlink (requires passkey session + PoP)
 * - POST /_auth/git/verify-unlink-token - Verify unlink token (called by platform API)
 */

import type { Hono } from 'hono';
import crypto from 'crypto';
import { getDeviceFingerprint, getClientIp } from '../auth/fingerprint';
import { logAuditEvent } from '../application/audit/Audit';
import { parseCookies } from '../utils/cookie';
import { getCurrentTier } from '../application/gates/Tier';
import { IS_ANDROID } from '@vps/shared/platform';
import {
  setGitSecret,
  getGitCredential,
  deleteAllGitSecrets,
} from '../application/credentials/GitCredentials';

// ============================================
// IN-MEMORY TOKEN STORE
// ============================================

interface GitLinkToken {
  repoFullName: string;
  provider: string;
  expiresAt: number;
}

interface GitUnlinkToken {
  expiresAt: number;
}

const gitLinkTokens = new Map<string, GitLinkToken>();
const gitUnlinkTokens = new Map<string, GitUnlinkToken>();

const TOKEN_TTL_MS = 60_000; // 60 seconds

// Cleanup expired tokens every 60s
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of gitLinkTokens) {
    if (data.expiresAt < now) gitLinkTokens.delete(token);
  }
  for (const [token, data] of gitUnlinkTokens) {
    if (data.expiresAt < now) gitUnlinkTokens.delete(token);
  }
}, 60_000);

// ============================================
// ROUTES
// ============================================

export function registerGitRoutes(app: Hono): void {

  /**
   * Authorize a git repo link.
   * Requires passkey session + PoP. Only enforced for web_locked tier.
   */
  app.post('/_auth/git/authorize-link', async (c) => {
    const tier = getCurrentTier();

    // Non-web_locked tiers don't need authorization
    if (tier === 'standard') {
      return c.json({ authorized: true, token: null });
    }

    // Session + PoP already verified by tier-gate middleware
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;

    const body = await c.req.json() as {
      repoFullName?: string;
      provider?: string;
    };

    if (!body.repoFullName || !body.provider) {
      return c.json({ error: 'repoFullName and provider are required' }, 400);
    }

    const validProviders = ['github', 'gitlab', 'bitbucket'];
    if (!validProviders.includes(body.provider)) {
      return c.json({ error: 'Invalid provider' }, 400);
    }

    // Generate single-use token bound to this repo
    const token = crypto.randomBytes(32).toString('hex');
    gitLinkTokens.set(token, {
      repoFullName: body.repoFullName,
      provider: body.provider,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    logAuditEvent({
      type: 'git_link_authorized',
      ip: getClientIp(c),
      fingerprint: getDeviceFingerprint(c).hash,
      details: {
        repoFullName: body.repoFullName,
        provider: body.provider,
      },
    });

    return c.json({
      authorized: true,
      token,
      expiresIn: TOKEN_TTL_MS / 1000,
    });
  });

  /**
   * Verify a git link token. Called by the platform API over TLS.
   * No session required — trusts TLS + token validity.
   */
  app.post('/_auth/git/verify-link-token', async (c) => {
    const body = await c.req.json() as {
      token?: string;
      repoFullName?: string;
      provider?: string;
    };

    if (!body.token || !body.repoFullName || !body.provider) {
      return c.json({ valid: false, error: 'missing_fields' });
    }

    // Look up and delete immediately (single-use)
    const stored = gitLinkTokens.get(body.token);
    gitLinkTokens.delete(body.token);

    if (!stored) {
      return c.json({ valid: false, error: 'invalid_token' });
    }

    if (Date.now() > stored.expiresAt) {
      return c.json({ valid: false, error: 'expired' });
    }

    if (stored.repoFullName !== body.repoFullName) {
      logAuditEvent({
        type: 'git_link_token_mismatch',
        ip: getClientIp(c),
        details: {
          expected: stored.repoFullName,
          received: body.repoFullName,
        },
      });
      return c.json({ valid: false, error: 'repo_mismatch' });
    }

    if (stored.provider !== body.provider) {
      return c.json({ valid: false, error: 'provider_mismatch' });
    }

    logAuditEvent({
      type: 'git_link_token_verified',
      ip: getClientIp(c),
      details: {
        repoFullName: body.repoFullName,
        provider: body.provider,
      },
    });

    return c.json({
      valid: true,
      repoFullName: body.repoFullName,
      provider: body.provider,
    });
  });

  /**
   * Authorize a git repo unlink.
   * Requires passkey session + PoP. Only enforced for web_locked tier.
   */
  app.post('/_auth/git/authorize-unlink', async (c) => {
    const tier = getCurrentTier();

    if (tier === 'standard') {
      return c.json({ authorized: true, token: null });
    }

    // Session + PoP already verified by tier-gate middleware
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;

    const token = crypto.randomBytes(32).toString('hex');
    gitUnlinkTokens.set(token, {
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    logAuditEvent({
      type: 'git_unlink_authorized',
      ip: getClientIp(c),
      fingerprint: getDeviceFingerprint(c).hash,
      details: {},
    });

    return c.json({
      authorized: true,
      token,
      expiresIn: TOKEN_TTL_MS / 1000,
    });
  });

  /**
   * Verify a git unlink token. Called by the platform API over TLS.
   */
  app.post('/_auth/git/verify-unlink-token', async (c) => {
    const body = await c.req.json() as {
      token?: string;
    };

    if (!body.token) {
      return c.json({ valid: false, error: 'missing_token' });
    }

    const stored = gitUnlinkTokens.get(body.token);
    gitUnlinkTokens.delete(body.token);

    if (!stored) {
      return c.json({ valid: false, error: 'invalid_token' });
    }

    if (Date.now() > stored.expiresAt) {
      return c.json({ valid: false, error: 'expired' });
    }

    logAuditEvent({
      type: 'git_unlink_token_verified',
      ip: getClientIp(c),
      details: {},
    });

    return c.json({ valid: true });
  });

  // ── Android-only: local git credential management ──────────────

  interface LocalGitProfile {
    provider: string;
    username: string;
    avatarUrl: string | null;
  }
  interface LocalLinkedRepo {
    fullName: string;
    url: string;
    isPrivate: boolean;
    defaultBranch: string;
    description: string | null;
  }
  let localProfile: LocalGitProfile | null = null;
  let localLinkedRepo: LocalLinkedRepo | null = null;

  function storeGitCredentials(provider: string, token: string, username: string, avatarUrl: string | null) {
    setGitSecret('__GIT_TOKEN', token);
    setGitSecret('__GIT_PROVIDER', provider);
    setGitSecret('__GIT_USER_NAME', provider === 'github' ? 'x-access-token' : 'oauth2');
    localProfile = { provider, username, avatarUrl };
  }

  // ── Android-only: GitHub device flow ──────────────────────────
  // Proxies GitHub's OAuth device flow so the browser doesn't need
  // direct CORS access to github.com. The client_id is provided by
  // the frontend (it's public — included in every OAuth redirect URL).

  interface DeviceFlowEntry {
    deviceCode: string;
    clientId: string;
    expiresAt: number;
    interval: number;
  }
  const deviceFlows = new Map<string, DeviceFlowEntry>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of deviceFlows) {
      if (entry.expiresAt < now) deviceFlows.delete(key);
    }
  }, 60_000);

  app.post('/_auth/git/device-flow/start', async (c) => {
    if (!IS_ANDROID) return c.json({ error: 'Not available' }, 404);

    const clientId = process.env.GITHUB_APP_CLIENT_ID;
    if (!clientId) {
      return c.json({ error: 'GitHub not configured on this server' }, 503);
    }

    try {
      const res = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        return c.json({ error: 'GitHub device flow unavailable' }, 502);
      }

      const data = (await res.json()) as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        expires_in: number;
        interval: number;
        error?: string;
      };

      if (data.error) {
        return c.json({ error: data.error }, 400);
      }

      const ref = crypto.randomBytes(16).toString('hex');
      deviceFlows.set(ref, {
        deviceCode: data.device_code,
        clientId,
        expiresAt: Date.now() + data.expires_in * 1000,
        interval: data.interval,
      });

      return c.json({
        ref,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresIn: data.expires_in,
        interval: data.interval,
      });
    } catch {
      return c.json({ error: 'Could not reach GitHub' }, 502);
    }
  });

  app.post('/_auth/git/device-flow/poll', async (c) => {
    if (!IS_ANDROID) return c.json({ error: 'Not available' }, 404);

    const body = await c.req.json() as { ref: string };
    const entry = deviceFlows.get(body.ref);

    if (!entry || entry.expiresAt < Date.now()) {
      if (entry) deviceFlows.delete(body.ref);
      return c.json({ status: 'expired' });
    }

    try {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: entry.clientId,
          device_code: entry.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        signal: AbortSignal.timeout(10_000),
      });

      const data = (await res.json()) as {
        access_token?: string;
        error?: string;
        interval?: number;
      };

      if (data.error === 'authorization_pending') {
        return c.json({ status: 'pending' });
      }
      if (data.error === 'slow_down') {
        if (data.interval) entry.interval = data.interval;
        return c.json({ status: 'pending', interval: entry.interval });
      }
      if (data.error) {
        deviceFlows.delete(body.ref);
        return c.json({ status: 'error', error: data.error });
      }

      let username = '';
      let avatarUrl: string | null = null;
      try {
        const profileRes = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${data.access_token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Ellul/1.0',
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (profileRes.ok) {
          const profile = (await profileRes.json()) as { login: string; avatar_url: string };
          username = profile.login;
          avatarUrl = profile.avatar_url;
        }
      } catch {}

      deviceFlows.delete(body.ref);

      storeGitCredentials('github', data.access_token!, username, avatarUrl);

      return c.json({
        status: 'authorized',
        username,
        avatarUrl,
      });
    } catch {
      return c.json({ status: 'pending', interval: entry.interval });
    }
  });

  // ── Android-only: credential management ───────────────────────

  app.post('/_auth/git/credentials', async (c) => {
    if (!IS_ANDROID) return c.json({ error: 'Not available' }, 404);

    const body = await c.req.json() as {
      provider?: string;
      token?: string;
      username?: string;
      avatarUrl?: string | null;
    };

    if (!body.provider || !body.token || !body.username) {
      return c.json({ error: 'provider, token, and username are required' }, 400);
    }

    storeGitCredentials(body.provider, body.token, body.username, body.avatarUrl ?? null);
    return c.json({ ok: true });
  });

  app.get('/_auth/git/connection', async (c) => {
    if (!IS_ANDROID) return c.json({ error: 'Not available' }, 404);

    const cred = getGitCredential('');
    if (!cred?.token || !localProfile) {
      return c.json({ connected: false });
    }

    return c.json({
      connected: true,
      provider: localProfile.provider,
      username: localProfile.username,
      avatarUrl: localProfile.avatarUrl,
      linkedRepo: localLinkedRepo,
    });
  });

  app.delete('/_auth/git/connection', async (c) => {
    if (!IS_ANDROID) return c.json({ error: 'Not available' }, 404);
    deleteAllGitSecrets();
    localProfile = null;
    localLinkedRepo = null;
    return c.json({ ok: true });
  });

  app.post('/_auth/git/link', async (c) => {
    if (!IS_ANDROID) return c.json({ error: 'Not available' }, 404);

    const cred = getGitCredential('');
    if (!cred?.token) {
      return c.json({ error: 'Connect a git provider first' }, 400);
    }

    const body = await c.req.json() as {
      fullName?: string;
      url?: string;
      isPrivate?: boolean;
      defaultBranch?: string;
      description?: string | null;
    };

    if (!body.fullName || !body.url) {
      return c.json({ error: 'fullName and url are required' }, 400);
    }

    setGitSecret('__GIT_REPO_URL', body.url);
    if (body.defaultBranch) {
      setGitSecret('__GIT_DEFAULT_BRANCH', body.defaultBranch);
    }

    localLinkedRepo = {
      fullName: body.fullName,
      url: body.url,
      isPrivate: body.isPrivate ?? false,
      defaultBranch: body.defaultBranch ?? 'main',
      description: body.description ?? null,
    };

    return c.json({ ok: true });
  });

  app.delete('/_auth/git/link', async (c) => {
    if (!IS_ANDROID) return c.json({ error: 'Not available' }, 404);
    localLinkedRepo = null;
    return c.json({ ok: true });
  });

  app.get('/_auth/git/repos', async (c) => {
    if (!IS_ANDROID) return c.json({ error: 'Not available' }, 404);

    const cred = getGitCredential('');
    if (!cred?.token) {
      return c.json({ error: 'No git credentials stored' }, 401);
    }

    const search = c.req.query('search') || '';
    const page = parseInt(c.req.query('page') || '1', 10);
    const perPage = 30;

    let url: string;
    if (search) {
      const owner = localProfile?.username;
      const userFilter = owner ? `+user:${encodeURIComponent(owner)}` : '';
      url = `https://api.github.com/search/repositories?q=${encodeURIComponent(search)}${userFilter}&sort=updated&per_page=${perPage}&page=${page}`;
    } else {
      url = `https://api.github.com/user/repos?sort=updated&per_page=${perPage}&page=${page}&affiliation=owner,collaborator`;
    }

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${cred.token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Ellul/1.0',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        return c.json({ error: 'GitHub API error', status: res.status }, 502);
      }

      const data = await res.json();
      const items = search ? (data as any).items ?? [] : data;
      const repos = (items as any[]).map((r: any) => ({
        name: r.name,
        fullName: r.full_name,
        url: r.clone_url,
        sshUrl: r.ssh_url,
        isPrivate: r.private,
        defaultBranch: r.default_branch,
        description: r.description,
        updatedAt: r.updated_at,
      }));

      return c.json({ repos });
    } catch {
      return c.json({ error: 'Failed to fetch repositories' }, 502);
    }
  });
}
