// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Vault UI — Self-contained HTML page for secrets management.
 *
 * Served locally by the auth-proxy engine at /_vault.
 * Uses Web Crypto API for client-side RSA-OAEP + AES-256-GCM encryption.
 * All API calls go through the same proxy origin (session + PoP injected).
 *
 * Zero-knowledge: encryption happens in the browser, only the VPS can decrypt.
 */

export function getVaultHtml(projectName?: string): string {
  const escapedProject = projectName
    ? projectName.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c)
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ellul — Secrets Vault</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, system-ui, 'Segoe UI', sans-serif;
      background: radial-gradient(ellipse at 20% 0%, rgba(245,239,230,0.4) 0%, transparent 60%),
                  radial-gradient(ellipse at 80% 100%, rgba(240,166,90,0.15) 0%, transparent 50%),
                  #0B0B0F;
      color: #F5EFE6;
      min-height: 100vh;
      padding: 1.5rem 1rem;
    }

    /* Brand */
    .brand { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1.25rem; }
    .brand svg { width: 24px; height: 24px; }
    .brand span { font-size: 0.95rem; font-weight: 700; color: #fff; }
    .brand .sep { color: rgba(245,239,230,0.25); margin: 0 0.15rem; }
    .brand .page { color: rgba(245,239,230,0.45); font-weight: 500; }

    /* Card */
    .card {
      background: rgba(19,19,26,0.7);
      border: 1px solid rgba(245,239,230,0.6);
      border-radius: 12px;
      padding: 1.25rem;
      backdrop-filter: blur(20px);
      margin-bottom: 1rem;
    }

    /* Headings */
    h2 { font-size: 0.85rem; font-weight: 600; color: #fff; margin-bottom: 0.75rem; }
    .subtitle { font-size: 0.7rem; color: rgba(245,239,230,0.45); margin-top: -0.5rem; margin-bottom: 0.75rem; }

    /* Secret list */
    .secret-list { display: flex; flex-direction: column; gap: 0.4rem; }
    .secret-item {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.6rem 0.75rem;
      background: rgba(11,11,15,0.6);
      border: 1px solid rgba(245,239,230,0.5);
      border-radius: 8px;
      font-size: 0.78rem;
    }
    .secret-name {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.75rem;
      color: #F4B873;
      font-weight: 500;
    }
    .secret-meta {
      font-size: 0.65rem;
      color: rgba(245,239,230,0.35);
      margin-left: 0.5rem;
    }
    .secret-actions { display: flex; gap: 0.3rem; }

    /* Buttons */
    .btn {
      padding: 0.35rem 0.65rem;
      border-radius: 6px;
      border: 1px solid;
      font-size: 0.7rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
      background: transparent;
    }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-danger {
      border-color: rgba(239,68,68,0.3);
      color: #E5806B;
    }
    .btn-danger:hover:not(:disabled) {
      background: rgba(239,68,68,0.1);
      border-color: rgba(239,68,68,0.5);
    }
    .btn-primary {
      border-color: rgba(240,166,90,0.3);
      color: #F4B873;
      background: linear-gradient(180deg, rgba(240,166,90,0.1) 0%, rgba(240,166,90,0.05) 100%);
    }
    .btn-primary:hover:not(:disabled) {
      background: linear-gradient(180deg, rgba(240,166,90,0.18) 0%, rgba(240,166,90,0.08) 100%);
      border-color: rgba(240,166,90,0.5);
    }
    .btn-full { width: 100%; padding: 0.55rem; font-size: 0.78rem; }

    /* Form */
    .form-row { margin-bottom: 0.6rem; }
    .form-label {
      display: block;
      font-size: 0.7rem;
      color: rgba(245,239,230,0.45);
      margin-bottom: 0.25rem;
      font-weight: 500;
    }
    .form-input {
      width: 100%;
      padding: 0.5rem 0.6rem;
      background: rgba(11,11,15,0.8);
      border: 1px solid rgba(245,239,230,0.5);
      border-radius: 6px;
      color: #F5EFE6;
      font-size: 0.78rem;
      font-family: 'SF Mono', 'Fira Code', monospace;
      outline: none;
      transition: border-color 0.15s;
    }
    .form-input:focus { border-color: rgba(240,166,90,0.5); }
    .form-input::placeholder { color: rgba(245,239,230,0.25); }
    select.form-input {
      font-family: -apple-system, system-ui, sans-serif;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2364748b' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 0.5rem center;
      padding-right: 1.5rem;
    }
    .form-row-inline { display: flex; gap: 0.5rem; }
    .form-row-inline > * { flex: 1; }

    /* States */
    .empty {
      text-align: center;
      padding: 2rem 1rem;
      color: rgba(245,239,230,0.35);
      font-size: 0.78rem;
    }
    .empty svg { width: 32px; height: 32px; margin: 0 auto 0.75rem; color: rgba(245,239,230,0.25); }
    .loading { text-align: center; padding: 2rem; color: rgba(245,239,230,0.45); font-size: 0.78rem; }
    .spinner {
      width: 18px; height: 18px;
      border: 2px solid rgba(240,166,90,0.15);
      border-top-color: #F0A65A;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      margin: 0 auto 0.5rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error-msg { color: #E5806B; font-size: 0.7rem; margin-top: 0.4rem; }
    .success-msg { color: #34d399; font-size: 0.7rem; margin-top: 0.4rem; }
    .toast {
      position: fixed;
      bottom: 1rem;
      left: 50%;
      transform: translateX(-50%);
      padding: 0.5rem 1rem;
      border-radius: 8px;
      font-size: 0.75rem;
      font-weight: 500;
      z-index: 100;
      animation: fadeUp 0.2s ease;
    }
    .toast-success { background: rgba(52,211,153,0.15); border: 1px solid rgba(52,211,153,0.3); color: #34d399; }
    .toast-error { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #E5806B; }
    @keyframes fadeUp { from { opacity: 0; transform: translateX(-50%) translateY(8px); } to { opacity: 1; transform: translateX(-50%); } }

    /* Divider */
    .divider { height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent); margin: 1rem 0; }

    /* Trust footer */
    .trust { display: flex; justify-content: center; gap: 1rem; margin-top: 1rem; }
    .trust-item { display: flex; align-items: center; gap: 0.25rem; }
    .trust-dot { width: 3px; height: 3px; border-radius: 50%; background: rgba(245,239,230,0.25); }
    .trust-label { font-size: 0.5rem; color: rgba(245,239,230,0.25); letter-spacing: 0.06em; text-transform: uppercase; font-weight: 500; }

    /* Env toggle */
    .env-tabs { display: flex; gap: 0.25rem; margin-bottom: 0.75rem; }
    .env-tab {
      padding: 0.3rem 0.6rem;
      border-radius: 6px;
      font-size: 0.7rem;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      background: transparent;
      color: rgba(245,239,230,0.35);
      transition: all 0.15s;
    }
    .env-tab.active {
      border-color: rgba(240,166,90,0.3);
      color: #F4B873;
      background: rgba(240,166,90,0.08);
    }
    .env-tab:hover:not(.active) { color: rgba(245,239,230,0.6); }

    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="brand">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#F0A65A"/><text x="16" y="22" text-anchor="middle" font-family="ui-monospace, monospace" font-size="20" font-weight="700" fill="#0B0B0F">e</text></svg>
    <span>ellul</span>
    <span class="sep">/</span>
    <span class="page">Secrets Vault</span>
  </div>

  <!-- Secrets List -->
  <div class="card">
    <h2>Environment Variables</h2>
    <div class="env-tabs">
      <button class="env-tab active" data-env="production" onclick="switchEnv('production')">Production</button>
      <button class="env-tab" data-env="development" onclick="switchEnv('development')">Development</button>
    </div>
    <div id="secrets-list" class="loading">
      <div class="spinner"></div>
      Loading secrets...
    </div>
  </div>

  <!-- Add Secret Form -->
  <div class="card" id="add-form">
    <h2>Add Secret</h2>
    <div class="form-row-inline">
      <div>
        <label class="form-label">Name</label>
        <input type="text" class="form-input" id="secret-name" placeholder="DATABASE_URL" autocomplete="off" spellcheck="false">
      </div>
      <div>
        <label class="form-label">Environment</label>
        <select class="form-input" id="secret-env">
          <option value="production">Production</option>
          <option value="development">Development</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <label class="form-label">Value</label>
      <input type="password" class="form-input" id="secret-value" placeholder="Enter secret value" autocomplete="off" spellcheck="false">
    </div>
    <button class="btn btn-primary btn-full" id="add-btn" onclick="addSecret()">
      Encrypt &amp; Save
    </button>
    <div id="add-error" class="error-msg hidden"></div>
  </div>

  <div class="trust">
    <div class="trust-item"><div class="trust-dot"></div><span class="trust-label">Zero-knowledge</span></div>
    <div class="trust-item"><div class="trust-dot"></div><span class="trust-label">E2E Encrypted</span></div>
    <div class="trust-item"><div class="trust-dot"></div><span class="trust-label">RSA-4096 + AES-256</span></div>
  </div>

  <script>
    // ── State ──
    let publicKeyPem = null;
    let currentEnv = 'production';
    const PROJECT = ${JSON.stringify(escapedProject)} || null;

    // ── Crypto: RSA-OAEP + AES-256-GCM (matches console's lib/crypto.ts) ──

    async function importPublicKey(pem) {
      const b64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\\s/g, '');
      const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      return crypto.subtle.importKey('spki', der.buffer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    }

    async function encryptSecret(pem, plaintext) {
      const rsaKey = await importPublicKey(pem);
      const aesKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(plaintext);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded));
      const rawAes = await crypto.subtle.exportKey('raw', aesKey);
      const encryptedKey = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, rsaKey, rawAes));
      const toB64 = buf => { let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]); return btoa(s); };
      return { encryptedKey: toB64(encryptedKey), iv: toB64(iv), encryptedData: toB64(ciphertext) };
    }

    // ── API Helpers ──

    async function apiGet(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      return res.json();
    }

    async function apiPost(path, body) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      return res.json();
    }

    async function apiDelete(path) {
      const res = await fetch(path, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      return res.json();
    }

    // ── Toast ──

    function showToast(msg, type) {
      const el = document.createElement('div');
      el.className = 'toast toast-' + type;
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 2500);
    }

    // ── Load secrets ──

    async function loadSecrets() {
      const list = document.getElementById('secrets-list');
      list.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';

      try {
        // Fetch public key if not cached
        if (!publicKeyPem) {
          const keyData = await apiGet('/_auth/secrets/public-key');
          publicKeyPem = keyData.publicKey;
        }

        // Fetch secrets
        let qs = '?env=' + currentEnv;
        if (PROJECT) qs += '&app=' + encodeURIComponent(PROJECT);
        const data = await apiGet('/_auth/secrets' + qs);

        const names = Array.isArray(data.names) ? data.names : [];

        if (names.length === 0) {
          list.innerHTML = '<div class="empty">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7 11V7a5 5 0 0 1 10 0v4"/><rect x="3" y="11" width="18" height="11" rx="2"/><circle cx="12" cy="16" r="1"/></svg>' +
            '<p>No secrets yet</p><p style="margin-top:0.25rem;font-size:0.7rem;color:rgba(245,239,230,0.25)">Add your first secret below</p></div>';
          return;
        }

        list.innerHTML = '<div class="secret-list">' + names.map(function(name) {
          return '<div class="secret-item">' +
            '<div><span class="secret-name">' + escapeHtml(name) + '</span>' +
            (PROJECT ? '' : '<span class="secret-meta">' + currentEnv + '</span>') +
            '</div>' +
            '<div class="secret-actions">' +
            '<button class="btn btn-danger" data-name=' + JSON.stringify(name) + ' onclick="deleteSecret(this.dataset.name)">Delete</button>' +
            '</div></div>';
        }).join('') + '</div>';
      } catch (err) {
        list.innerHTML = '<div class="empty" style="color:#E5806B">' +
          '<p>Failed to load secrets</p>' +
          '<p style="margin-top:0.25rem;font-size:0.7rem">' + escapeHtml(err.message) + '</p></div>';
      }
    }

    // ── Add secret ──

    async function addSecret() {
      const nameEl = document.getElementById('secret-name');
      const valueEl = document.getElementById('secret-value');
      const envEl = document.getElementById('secret-env');
      const btn = document.getElementById('add-btn');
      const errEl = document.getElementById('add-error');
      errEl.classList.add('hidden');

      const name = nameEl.value.trim();
      const value = valueEl.value;
      const env = envEl.value;

      if (!name) { showError(errEl, 'Name is required'); return; }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) { showError(errEl, 'Invalid name — use letters, digits, underscores'); return; }
      if (value === '') { showError(errEl, 'Value is required'); return; }

      btn.disabled = true;
      btn.textContent = 'Encrypting...';

      try {
        if (!publicKeyPem) {
          const keyData = await apiGet('/_auth/secrets/public-key');
          publicKeyPem = keyData.publicKey;
        }

        const envelope = await encryptSecret(publicKeyPem, value);

        await apiPost('/_auth/secrets', {
          name,
          appName: PROJECT || '_global',
          env,
          ...envelope,
        });

        nameEl.value = '';
        valueEl.value = '';
        showToast('Secret "' + name + '" saved', 'success');
        await loadSecrets();
      } catch (err) {
        showError(errEl, err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Encrypt & Save';
      }
    }

    // ── Delete secret ──

    async function deleteSecret(name) {
      if (!confirm('Delete secret "' + name + '"?')) return;

      try {
        let path = '/_auth/secrets/' + encodeURIComponent(name);
        const params = new URLSearchParams();
        if (PROJECT) params.set('app', PROJECT);
        params.set('env', currentEnv);
        path += '?' + params.toString();

        await apiDelete(path);
        showToast('Secret "' + name + '" deleted', 'success');
        await loadSecrets();
      } catch (err) {
        showToast('Delete failed: ' + err.message, 'error');
      }
    }

    // ── Env switching ──

    function switchEnv(env) {
      currentEnv = env;
      document.querySelectorAll('.env-tab').forEach(function(tab) {
        tab.classList.toggle('active', tab.dataset.env === env);
      });
      loadSecrets();
    }

    // ── Helpers ──

    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function showError(el, msg) {
      el.textContent = msg;
      el.classList.remove('hidden');
    }

    // ── Init ──
    loadSecrets();
  </script>
</body>
</html>`;
}
