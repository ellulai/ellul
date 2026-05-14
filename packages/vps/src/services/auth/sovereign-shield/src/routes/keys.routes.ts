// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * SSH Keys Routes
 *
 * SSH key management endpoints (web_locked tier only, enforced by tier-gate middleware).
 *
 * Endpoints:
 * - GET  /_auth/keys              - SSH key management UI (HTML)
 * - GET  /_auth/api/keys          - JSON API for SSH keys
 * - POST /_auth/keys              - Add SSH key
 * - DELETE /_auth/keys/:fingerprint - Remove SSH key
 */

import crypto from 'crypto';
import { execSync, execFileSync } from 'child_process';
import type { Hono, Context } from 'hono';
import { getDeviceFingerprint, getClientIp } from '../auth/fingerprint';
import { validateSession, refreshSession, setSessionCookie } from '../auth/session';
import { getCurrentTier, notifyPlatformSshKeyChange, notifyPlatformSettingsChange } from '../application/gates/Tier';
import { logAuditEvent } from '../application/audit/Audit';
import { syncSettingsAfterKeyChange } from '../application/platform/Settings';
import { parseCookies } from '../utils/cookie';
import { generateCspNonce, getCspHeader } from '../utils/csp';

// Privileged wrapper that owns the authorized_keys file (root-only). shield-runner
// invokes it via sudo for read/write so the file can stay 0600 root:root — sshd
// reads it via the AuthorizedKeysCommand which also runs as root. See
// packages/vps/src/shell/security/shield-ssh-key-mgr.sh.
const SSH_KEY_MGR = '/usr/local/bin/shield-ssh-key-mgr';

interface SshKey {
  fingerprint: string;
  name: string;
  publicKey: string;
}

/**
 * Compute SSH fingerprint from public key
 */
function computeSshFingerprint(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/);
  const keyPart = parts[1];
  if (parts.length < 2 || !keyPart) return 'unknown';
  try {
    const keyData = Buffer.from(keyPart, 'base64');
    const hash = crypto.createHash('sha256').update(keyData).digest('base64');
    return 'SHA256:' + hash.replace(/=+$/, '');
  } catch {
    return 'unknown';
  }
}

/**
 * Get all SSH keys from authorized_keys via the privileged wrapper.
 * shield-runner cannot read the file directly (0600 root:root), so the
 * `list` subcommand runs via sudo and pipes the file contents back.
 */
function getSshKeys(): SshKey[] {
  const keys: SshKey[] = [];
  let content = '';
  try {
    content = execFileSync('sudo', ['-n', SSH_KEY_MGR, 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return keys;
  }
  const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      const fingerprint = computeSshFingerprint(line);
      const comment = parts.length > 2 ? parts.slice(2).join(' ') : 'SSH Key';
      keys.push({ fingerprint, name: comment, publicKey: line.trim() });
    }
  }
  return keys;
}

/**
 * Verify the tier is web_locked.
 * Auth (session + PoP) is already enforced by tier-gate middleware — handlers
 * only need to check the tier-specific business rule.
 */
function requireWebLockedTier(c: Context): Response | null {
  const currentTier = getCurrentTier();
  if (currentTier === 'standard') {
    return c.json({ error: 'SSH key management requires Web Locked tier' }, 403) as unknown as Response;
  }
  return null;
}

/**
 * Escape HTML for safe rendering
 */
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Register SSH key routes on Hono app
 */
export function registerKeysRoutes(app: Hono, hostname: string): void {
  /**
   * SSH key management UI (HTML page)
   */
  app.get('/_auth/keys', async (c) => {
    // Auth (session + PoP) already enforced by tier-gate middleware
    const rejected = requireWebLockedTier(c);
    if (rejected) return rejected;

    // Refresh session for cookie rotation
    const cookies = parseCookies(c.req.header('cookie'));
    const sessionId = cookies.shield_session;
    if (sessionId) {
      const ip = getClientIp(c);
      const fingerprintData = getDeviceFingerprint(c);
      const result = validateSession(sessionId, ip, fingerprintData, '/_auth/keys');
      if (result.valid && result.session) {
        const refresh = refreshSession(result.session, ip, fingerprintData);
        if (refresh.rotated) {
          setSessionCookie(c, refresh.sessionId, hostname);
        }
      }
    }

    const keys = getSshKeys();

    const kNonce = generateCspNonce();
    c.header('Content-Security-Policy', getCspHeader(kNonce));
    return c.html(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SSH Keys - Sovereign Shield</title>
  <style nonce="${kNonce}">
    * { box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 520px; margin: 20px auto; padding: 20px; background: #0B0B0F; color: #e0e0e0; }
    h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
    .subtitle { color: rgba(245,239,230,0.45); font-size: 0.9rem; margin-bottom: 24px; }
    .key-list { margin-bottom: 24px; }
    .key-item { display: flex; justify-content: space-between; align-items: center; padding: 12px; border: 1px solid #2a2a3e; border-radius: 8px; margin-bottom: 8px; background: #12121a; }
    .key-info { flex: 1; min-width: 0; }
    .key-name { font-weight: 500; color: #e0e0e0; margin-bottom: 4px; }
    .key-fingerprint { font-family: monospace; font-size: 11px; color: rgba(245,239,230,0.45); overflow: hidden; text-overflow: ellipsis; }
    .btn { padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; font-size: 0.9rem; font-weight: 500; }
    .btn-danger { background: #3f1515; color: #E5806B; }
    .btn-danger:hover { background: #5f1f1f; }
    .btn-primary { background: #7c3aed; color: white; width: 100%; padding: 12px; margin-top: 8px; }
    .btn-primary:hover { background: #6d28d9; }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .form { margin-top: 24px; padding-top: 24px; border-top: 1px solid #2a2a3e; }
    .form-group { margin-bottom: 12px; }
    .form-label { display: block; font-size: 0.85rem; color: rgba(245,239,230,0.45); margin-bottom: 6px; }
    .form-input { width: 100%; padding: 10px; background: #12121a; border: 1px solid #2a2a3e; border-radius: 6px; color: #e0e0e0; font-size: 0.9rem; }
    .form-input:focus { outline: none; border-color: #7c3aed; }
    textarea.form-input { min-height: 80px; font-family: monospace; font-size: 12px; resize: vertical; }
    .empty { color: rgba(245,239,230,0.45); text-align: center; padding: 40px 20px; }
    .error { color: #E5806B; font-size: 0.85rem; margin-top: 8px; display: none; }
    .success { color: #22c55e; font-size: 0.85rem; margin-top: 8px; display: none; }
    .note { font-size: 0.8rem; color: #666; margin-top: 16px; padding: 12px; background: #1a1a2e; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>SSH Keys</h1>
  <p class="subtitle">Manage SSH access to your server (passkey protected)</p>

  <div class="key-list" id="key-list">
    ${keys.length === 0 ? `
      <div class="empty">
        <p>No SSH keys configured.</p>
        <p style="font-size: 0.85rem; margin-top: 8px;">SSH server will start when you add a key.</p>
      </div>
    ` : keys.map(key => `
      <div class="key-item" data-fingerprint="${key.fingerprint}">
        <div class="key-info">
          <div class="key-name">${escapeHtml(key.name)}</div>
          <div class="key-fingerprint">${key.fingerprint}</div>
        </div>
        <button class="btn btn-danger btn-remove" data-fingerprint="${key.fingerprint}">Remove</button>
      </div>
    `).join('')}
  </div>

  <div class="form">
    <div class="form-group">
      <label class="form-label">Key Name (optional)</label>
      <input type="text" class="form-input" id="key-name" placeholder="MacBook Pro, Work Laptop, etc.">
    </div>
    <div class="form-group">
      <label class="form-label">Public Key</label>
      <textarea class="form-input" id="public-key" placeholder="ssh-ed25519 AAAA... or ssh-rsa AAAA..."></textarea>
    </div>
    <button class="btn btn-primary" id="add-btn">Add SSH Key</button>
    <p class="error" id="error-msg"></p>
    <p class="success" id="success-msg"></p>
  </div>

  <div class="note">
    <strong>How it works:</strong> SSH keys added here are stored directly on your server.
    When keys are present, the SSH server runs. Remove all keys to disable SSH access.
  </div>

  <script nonce="${kNonce}">
    async function addKey() {
      const name = document.getElementById('key-name').value.trim();
      const publicKey = document.getElementById('public-key').value.trim();
      const btn = document.getElementById('add-btn');
      const errEl = document.getElementById('error-msg');
      const successEl = document.getElementById('success-msg');

      errEl.style.display = 'none';
      successEl.style.display = 'none';

      if (!publicKey) {
        errEl.textContent = 'Public key is required';
        errEl.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Adding...';

      try {
        const res = await fetch('/_auth/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, publicKey }),
          credentials: 'include',
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Failed to add key');
        }

        successEl.textContent = 'SSH key added successfully!';
        successEl.style.display = 'block';
        setTimeout(() => location.reload(), 1000);
      } catch (e) {
        errEl.textContent = e.message;
        errEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Add SSH Key';
      }
    }

    async function removeKey(fingerprint) {
      if (!confirm('Remove this SSH key?')) return;

      try {
        const res = await fetch('/_auth/keys/' + encodeURIComponent(fingerprint), {
          method: 'DELETE',
          credentials: 'include',
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to remove key');
        }

        location.reload();
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    // Bind click handlers via JS (not inline onclick — CSP blocks inline handlers)
    document.getElementById('add-btn').addEventListener('click', addKey);
    document.querySelectorAll('.btn-remove').forEach(function(btn) {
      btn.addEventListener('click', function() {
        removeKey(this.getAttribute('data-fingerprint'));
      });
    });
  </script>
</body>
</html>`);
  });

  /**
   * JSON API for SSH keys — auth enforced by tier-gate middleware
   */
  app.get('/_auth/api/keys', async (c) => {
    const rejected = requireWebLockedTier(c);
    if (rejected) return rejected;

    const keys = getSshKeys();
    return c.json({ keys, tier: getCurrentTier() });
  });

  /**
   * Add SSH key — auth enforced by tier-gate middleware (session + PoP)
   */
  app.post('/_auth/keys', async (c) => {
    const rejected = requireWebLockedTier(c);
    if (rejected) return rejected;

    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);
    const body = await c.req.json() as { name?: string; publicKey?: string };
    const { name, publicKey } = body;

    if (!publicKey || typeof publicKey !== 'string') {
      return c.json({ error: 'Public key is required' }, 400);
    }

    const trimmedKey = publicKey.trim();

    // Validate key format
    if (!/^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp\d+)\s+/.test(trimmedKey)) {
      return c.json({ error: 'Invalid SSH public key format' }, 400);
    }

    if (trimmedKey.includes('PRIVATE KEY')) {
      return c.json({ error: 'You pasted a PRIVATE key! Only paste the PUBLIC key.' }, 400);
    }

    const keyFingerprint = computeSshFingerprint(trimmedKey);

    // Check for duplicate
    const existingKeys = getSshKeys();
    if (existingKeys.some(k => k.fingerprint === keyFingerprint)) {
      return c.json({ error: 'This key is already added' }, 400);
    }

    // Add key to authorized_keys (atomic: open port first for web_locked tier)
    const currentTier = getCurrentTier();
    const existingKeyCount = existingKeys.length;
    let portWasOpened = false;

    try {
      // For web_locked tier: open SSH port FIRST (before adding key)
      // This ensures atomic behavior - port is open before key is written
      if (currentTier !== 'standard' && existingKeyCount === 0) {
        console.log('[shield] Web Locked: Opening SSH port before adding first key...');
        execSync('ufw allow 22/tcp comment SSH 2>/dev/null || true', { stdio: 'pipe' });
        execSync('systemctl enable --now sshd 2>/dev/null || true', { stdio: 'pipe' });
        portWasOpened = true;
      }

      // Add key via the privileged wrapper. Wrapper validates the key line
      // (regex + ssh-keygen parse), drops any duplicate of the same fingerprint,
      // writes 0600 root:root, and re-applies chattr +i. Stdout = fingerprint.
      const keyLine = name ? `${trimmedKey} ${name}` : trimmedKey;
      execFileSync('sudo', ['-n', SSH_KEY_MGR, 'add', keyLine], { stdio: ['ignore', 'pipe', 'pipe'] });

      // Verify key was actually added
      const newKeys = getSshKeys();
      const keyAdded = newKeys.some(k => k.fingerprint === keyFingerprint);
      if (!keyAdded) {
        throw new Error('Key was not written to authorized_keys');
      }

      // Sync settings.json with key state (so heartbeat reports correctly)
      const effectiveSettings = syncSettingsAfterKeyChange();

      // Notify platform of key change + settings change
      notifyPlatformSshKeyChange('added', keyFingerprint, name || 'SSH Key', trimmedKey);
      notifyPlatformSettingsChange(effectiveSettings, ip, c.req.header('user-agent') || 'unknown')
        .catch(e => console.warn('[shield] Settings webhook failed:', e.message));

      logAuditEvent({ type: 'ssh_key_added', ip, fingerprint: fingerprintData.hash, details: { keyFingerprint, name, tier: currentTier } });

      return c.json({ success: true, fingerprint: keyFingerprint, sshEnabled: effectiveSettings.sshEnabled });
    } catch (e) {
      console.error('[shield] Error adding SSH key:', e);

      // Rollback: if we opened the port and there are no other keys, close it
      if (portWasOpened && existingKeyCount === 0) {
        console.log('[shield] Rolling back SSH port opening due to key add failure...');
        try {
          execSync('ufw delete allow 22/tcp 2>/dev/null || true', { stdio: 'ignore' });
          execSync('systemctl disable --now sshd 2>/dev/null || true', { stdio: 'ignore' });
        } catch (rollbackErr) {
          console.error('[shield] Rollback failed:', rollbackErr);
        }
      }
      // Note: Don't close port if other keys exist - only rollback what we changed

      return c.json({ error: 'Failed to add SSH key' }, 500);
    }
  });

  /**
   * Remove SSH key — auth enforced by tier-gate middleware (session + PoP)
   */
  app.delete('/_auth/keys/:fingerprint', async (c) => {
    const rejected = requireWebLockedTier(c);
    if (rejected) return rejected;

    const ip = getClientIp(c);
    const fingerprintData = getDeviceFingerprint(c);
    const keyFingerprint = decodeURIComponent(c.req.param('fingerprint'));

    // Reject anything that doesn't look like a SHA256 fingerprint up front —
    // the wrapper also enforces this, but we want a clean 400 from the route.
    if (!/^SHA256:[A-Za-z0-9+/]+=*$/.test(keyFingerprint)) {
      return c.json({ error: 'Invalid fingerprint' }, 400);
    }

    try {
      const before = getSshKeys();
      if (before.length === 0) {
        return c.json({ error: 'No SSH keys found' }, 404);
      }
      if (!before.some(k => k.fingerprint === keyFingerprint)) {
        return c.json({ error: 'Key not found' }, 404);
      }

      // Remove via the privileged wrapper (atomic rewrite, restores chattr +i).
      execFileSync('sudo', ['-n', SSH_KEY_MGR, 'remove', keyFingerprint], { stdio: ['ignore', 'pipe', 'pipe'] });

      // Check if any keys remain — close port if none left
      const remainingKeys = getSshKeys();
      if (remainingKeys.length === 0) {
        console.log('[shield] No SSH keys remaining, stopping sshd...');
        execSync('systemctl disable --now sshd 2>/dev/null || true', { stdio: 'ignore' });
        execSync('ufw delete allow 22/tcp 2>/dev/null || true', { stdio: 'ignore' });
      }

      // Sync settings.json with key state (so heartbeat reports correctly)
      const effectiveSettings = syncSettingsAfterKeyChange();

      // Notify platform of key change + settings change
      notifyPlatformSshKeyChange('removed', keyFingerprint, 'SSH Key');
      notifyPlatformSettingsChange(effectiveSettings, ip, c.req.header('user-agent') || 'unknown')
        .catch(e => console.warn('[shield] Settings webhook failed:', e.message));

      logAuditEvent({ type: 'ssh_key_removed', ip, fingerprint: fingerprintData.hash, details: { keyFingerprint } });

      return c.json({ success: true, sshEnabled: effectiveSettings.sshEnabled });
    } catch (e) {
      console.error('[shield] Error removing SSH key:', e);
      return c.json({ error: 'Failed to remove SSH key' }, 500);
    }
  });
}

// Export helpers for other modules
export { getSshKeys, computeSshFingerprint };
