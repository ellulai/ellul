// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// WebAuthn imports removed — all passkey operations now happen in top-level popups
// (Safari/WebKit blocks navigator.credentials in cross-origin iframes).
// The bridge only handles session exchange, token minting, and PoP binding.

// Placeholders substituted at serve time by static.routes.ts.
const DASHBOARD_ORIGINS = __DASHBOARD_ORIGINS__;
let session = null;
let sessionCheckedAt = 0; // Timestamp of last successful session check
const SESSION_CHECK_TTL = 60000; // Don't re-check within 60s of a successful check
let pendingAuth = null;
let pendingSessionCheck = null;
let popReady = false;
let pendingPoP = null;

// SECURITY: Capture the exact parent origin when iframe loads
let PARENT_ORIGIN = null;
try {
  if (document.referrer) {
    const referrerUrl = new URL(document.referrer);
    PARENT_ORIGIN = referrerUrl.origin;
  }
} catch (e) {
  console.warn('[Bridge] Could not parse referrer:', e.message);
}

// Initialize PoP before signaling ready
async function initPoP() {
  if (popReady) return;
  if (pendingPoP) return pendingPoP;
  if (typeof SESSION_POP === 'undefined') {
    throw new Error('SESSION_POP not available');
  }
  pendingPoP = (async () => {
    await SESSION_POP.initialize();
    if (!window.__popFetchWrapped) {
      SESSION_POP.wrapFetch();
      window.__popFetchWrapped = true;
    }
    popReady = true;
  })();
  try { await pendingPoP; } finally { pendingPoP = null; }
}

// Secure origin validation
function isValidOrigin(origin) {
  if (PARENT_ORIGIN) {
    if (origin === PARENT_ORIGIN) return true;
    if (DASHBOARD_ORIGINS.includes(origin)) return true;
    console.warn('[Bridge] Rejected message from non-parent origin:', origin);
    return false;
  }
  if (DASHBOARD_ORIGINS.includes(origin)) return true;
  // Pattern substituted at serve time — covers platform + app zone subdomains for this VPS.
  const subdomainPattern = new RegExp(__SUBDOMAIN_PATTERN__);
  return subdomainPattern.test(origin);
}

// Listen for dashboard messages
window.addEventListener('message', async (event) => {
  if (!isValidOrigin(event.origin)) return;

  // Capture parent origin from the first valid dashboard message if
  // document.referrer was unavailable (e.g. strict Referrer-Policy).
  if (!PARENT_ORIGIN && DASHBOARD_ORIGINS.includes(event.origin)) {
    PARENT_ORIGIN = event.origin;
  }

  const { type, requestId, ...data } = event.data;

  try {
    const result = await handleMessage(type, data);
    respond(requestId, { success: true, ...result });
  } catch (err) {
    const errMsg = typeof err?.message === 'string' ? err.message : String(err?.message ?? err ?? 'Unknown error');
    respond(requestId, { success: false, error: errMsg });
  }
});

// Centralized session recovery: ask the console to do native passkey auth.
// The console calls authenticateNative() which triggers inline Touch ID,
// then sends get_auth_options/verify_auth through the bridge. The verify_auth
// handler sets the session cookie + PoP. The console signals completion via
// 'auth_completed' postMessage.
// Deduplicates concurrent recovery attempts.
let recoveryInProgress = null;

async function attemptSessionRecovery() {
  if (recoveryInProgress) return recoveryInProgress;

  recoveryInProgress = (async () => {
    try {
      const success = await requestReauthFromConsole('session_refresh');
      return !!success;
    } catch {
      return false;
    }
  })();

  try {
    return await recoveryInProgress;
  } finally {
    recoveryInProgress = null;
  }
}

// Shared token fetch with PoP error recovery AND 401 session recovery
async function fetchTokenWithPopRecovery(endpoint, label) {
  await requireSession();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(endpoint, { method: 'POST', credentials: 'include' });
    if (res.ok) return await res.json();
    const err = await res.json().catch(() => ({}));

    // Session expired — attempt recovery once
    if (res.status === 401 && attempt === 1) {
      const recovered = await attemptSessionRecovery();
      if (recovered) continue;
      throw new Error('Session expired. Please re-authenticate.');
    }

    const isPopError = err.reason && (
      err.reason === 'pop_not_bound' ||
      err.reason.includes('pop') ||
      err.reason === 'missing_pop_headers'
    );
    if (isPopError && attempt < 3) {
      // PoP key may be stale/missing - reinitialize before retry
      popReady = false;
      try { await initPoP(); } catch {}
      await new Promise(r => setTimeout(r, 500 * attempt));
      continue;
    }
    throw new Error(err.error || 'Failed to get ' + label);
  }
  throw new Error('Failed to get ' + label + ' after retries');
}

// fetchJson / postJson with one-shot 401 session recovery.
// extraHeaders is for X-STS-Token and similar — Content-Type / Accept are
// set automatically and should not be passed in.
async function fetchJson(url, extraHeaders) {
  var headers = { Accept: 'application/json' };
  if (extraHeaders) {
    for (var k in extraHeaders) {
      if (Object.prototype.hasOwnProperty.call(extraHeaders, k)) headers[k] = extraHeaders[k];
    }
  }
  var opts = { credentials: 'include', headers: headers };
  var res = await fetch(url, opts);
  if (res.status === 401) {
    var recovered = await attemptSessionRecovery();
    if (recovered) {
      res = await fetch(url, opts);
    }
  }
  if (!res.ok) {
    var error = await res.json().catch(function() { return {}; });
    throw new Error(error.error || 'Request failed');
  }
  return res.json();
}

async function postJson(url, body, extraHeaders) {
  var headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (extraHeaders) {
    for (var k in extraHeaders) {
      if (Object.prototype.hasOwnProperty.call(extraHeaders, k)) headers[k] = extraHeaders[k];
    }
  }
  var opts = {
    method: 'POST',
    credentials: 'include',
    headers: headers,
    body: JSON.stringify(body),
  };
  var res = await fetch(url, opts);
  if (res.status === 401) {
    var recovered = await attemptSessionRecovery();
    if (recovered) {
      res = await fetch(url, opts);
    }
  }
  if (!res.ok) {
    var error = await res.json().catch(function() { return {}; });
    throw new Error(error.error || 'Request failed');
  }
  return res.json();
}

async function deleteJson(url) {
  var opts = { method: 'DELETE', credentials: 'include' };
  var res = await fetch(url, opts);
  if (res.status === 401) {
    var recovered = await attemptSessionRecovery();
    if (recovered) {
      res = await fetch(url, opts);
    }
  }
  if (!res.ok) {
    var error = await res.json().catch(function() { return {}; });
    throw new Error(error.error || 'Request failed');
  }
  return res.json();
}

async function patchJson(url, body) {
  var opts = {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  var res = await fetch(url, opts);
  if (res.status === 401) {
    var recovered = await attemptSessionRecovery();
    if (recovered) {
      res = await fetch(url, opts);
    }
  }
  if (!res.ok) {
    var error = await res.json().catch(function() { return {}; });
    throw new Error(error.error || 'Request failed');
  }
  return res.json();
}

async function handleMessage(type, data) {
  switch (type) {
    case 'check_session':
      return { hasSession: await checkSession() };

    // Native WebAuthn relay: console does the passkey ceremony (top-level, Safari-safe),
    // bridge relays the options/assertions to the VPS for verification.
    case 'get_auth_options': {
      // Relay authentication options from VPS to console
      var authOptRes = await fetch('/_auth/login/options', {
        method: 'POST',
        credentials: 'include',
      });
      if (!authOptRes.ok) {
        var authOptErr = await authOptRes.json().catch(function() { return {}; });
        throw new Error(authOptErr.error || 'Failed to get auth options');
      }
      return await authOptRes.json();
    }

    case 'verify_auth': {
      // Relay completed WebAuthn assertion from console to VPS
      var verAuthRes = await fetch('/_auth/login/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assertion: data.assertion }),
      });
      if (!verAuthRes.ok) {
        var verAuthErr = await verAuthRes.json().catch(function() { return {}; });
        throw new Error(verAuthErr.error || 'Authentication failed');
      }
      var verAuthResult = await verAuthRes.json();
      // Session cookie is now set on this iframe's origin.
      // Re-initialize PoP for the new session and signal the console.
      session = null;
      sessionCheckedAt = 0;
      popReady = false;
      try { await initPoP(); } catch (e) { console.warn('[Bridge] PoP init after native auth:', e.message); }
      await checkSession();
      notifyParent({ type: 'bridge_ready', pop: popReady });
      return { verified: true, exchangeCode: verAuthResult.exchangeCode };
    }

    case 'get_registration_options': {
      // Relay registration options from VPS to console for native passkey registration
      var regOptRes = await fetch(data.endpoint || '/_auth/upgrade-to-web-locked', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: data.name }),
      });
      if (!regOptRes.ok) {
        var regOptErr = await regOptRes.json().catch(function() { return {}; });
        throw new Error(regOptErr.error || 'Failed to get registration options');
      }
      return await regOptRes.json();
    }

    case 'verify_registration': {
      // Relay completed WebAuthn attestation from console to VPS
      var verRegRes = await fetch(data.endpoint || '/_auth/upgrade-to-web-locked/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attestation: data.attestation, name: data.name, prfEnabled: data.prfEnabled }),
      });
      if (!verRegRes.ok) {
        var verRegErr = await verRegRes.json().catch(function() { return {}; });
        throw new Error(verRegErr.error || 'Registration failed');
      }
      var verRegResult = await verRegRes.json();
      // Session cookie set. Re-initialize PoP and signal console.
      session = null;
      sessionCheckedAt = 0;
      popReady = false;
      try { await initPoP(); } catch (e) { console.warn('[Bridge] PoP init after registration:', e.message); }
      await checkSession();
      notifyParent({ type: 'bridge_ready', pop: popReady });
      return verRegResult;
    }

    case 'get_ssh_keys':
      await requireSession();
      return { keys: await fetchKeys() };

    case 'add_ssh_key':
      await requireSession();
      return await addKey(data.name, data.publicKey);

    case 'remove_ssh_key':
      await requireSession();
      return await removeKey(data.fingerprint);

    case 'get_passkeys':
      await requireSession();
      return { passkeys: await fetchPasskeys() };

    case 'register_passkey':
      return await registerPasskey(data.name);

    case 'remove_passkey':
      await requireSession();
      return await removePasskey(data.credentialId);

    case 'upgrade_to_web_locked':
      return await upgradeToWebLocked(data.name);

    case 'downgrade_to_standard':
      // Don't requireSession() here — downgradeToStandard handles 401 with re-auth flow
      return await downgradeToStandard();

    case 'switch_to_web_locked':
      return await switchToWebLocked(data.name);

    case 'get_current_tier':
      return await getCurrentTierInfo();

    case 'confirm_operation':
      // Don't requireSession() here — confirmOperation handles 401 with re-auth flow
      return await confirmOperation(data.operation);

    case 'exchange_session':
      // Console passes an exchange code from the re-auth popup.
      // Exchange it for a session cookie, then re-bind PoP to the new session
      // so all subsequent operations work immediately (no PoP error recovery needed).
      // Sends bridge_ready on success so the console dismisses AuthWall/expired state.
      if (data.exchangeCode) {
        const exRes = await fetch('/_auth/session/exchange', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exchangeCode: data.exchangeCode }),
        });
        if (exRes.ok) {
          session = null;
          sessionCheckedAt = 0;
          popReady = false;
          try { await initPoP(); } catch (e) { console.warn('[Bridge] PoP re-init after exchange:', e.message); }
          await checkSession();
          // Signal parent that auth is now valid — dismisses AuthWall
          notifyParent({ type: 'bridge_ready', pop: popReady });
        }
        return { success: exRes.ok };
      }
      return { success: false };

    case 'session_keepalive':
      // Console requests a session refresh
      try {
        const kaRes = await fetch('/_auth/session/keepalive', {
          method: 'POST',
          credentials: 'include',
        });
        return await kaRes.json();
      } catch {
        return { alive: false, reason: 'fetch_failed' };
      }

    case 'get_code_token':
      return await fetchTokenWithPopRecovery('/_auth/code/authorize', 'code token');

    case 'get_code_session':
      return await fetchTokenWithPopRecovery('/_auth/code/session', 'code session');

    case 'get_exchange_code':
      // Both tiers: create a one-time exchange code for cross-origin iframe auth.
      // web_locked: uses fetchTokenWithPopRecovery (session + PoP required)
      // standard: direct POST (JWT cookie handles auth, no PoP needed)
      if (SECURITY_TIER !== 'standard') {
        return await fetchTokenWithPopRecovery('/_auth/bridge/exchange-code', 'exchange code');
      }
      return await postJson('/_auth/bridge/exchange-code', {});

    case 'get_agent_token':
      return await fetchTokenWithPopRecovery('/_auth/agent/authorize', 'agent token');

    case 'get_terminal_token':
      return await fetchTokenWithPopRecovery('/_auth/terminal/authorize', 'terminal token');

    case 'get_preview_token':
      return await fetchTokenWithPopRecovery('/_auth/preview/authorize', 'preview token');

    case 'get_settings':
      await requireSession();
      return await fetchJson('/_auth/bridge/settings');

    case 'toggle_terminal':
      await requireSession();
      return await postJson('/_auth/bridge/toggle-terminal', { enabled: data.enabled });

    case 'toggle_ssh':
      await requireSession();
      return await postJson('/_auth/bridge/toggle-ssh', { enabled: data.enabled });

    case 'set_view_mode':
      await requireSession();
      return await postJson('/_auth/bridge/set-view-mode', { mode: data.mode });

    case 'set_ui_mode':
      await requireSession();
      return await postJson('/_auth/bridge/set-ui-mode', { mode: data.mode });

    case 'set_secret':
      await requireSession();
      return await setSecretViaApi(data);

    case 'delete_secret':
      await requireSession();
      return await deleteSecretViaApi(data.name, data.sandboxId);

    case 'list_secrets':
      await requireSession();
      return await listSecretsViaApi(data.sandboxId, data.env);

    case 'read_secret_values':
      await requireSession();
      return await readSecretValuesViaApi(data.sandboxId, data.env);

    case 'set_secrets_bulk':
      await requireSession();
      return await setSecretsBulkViaApi(data.secrets, data.sandboxId);

    case 'authorize_git_link':
      await requireSession();
      return await authorizeGitLink(data.repoFullName, data.provider);

    case 'authorize_git_unlink':
      await requireSession();
      return await authorizeGitUnlink();

    case 'kill_ports':
      await requireSession();
      return await postJson('/_auth/bridge/kill-ports', { ports: data.ports });

    case 'git_action':
      await requireSession();
      return await postJson('/_auth/bridge/git-action', { action: data.action, sandboxId: data.sandboxId });

    case 'switch_deployment':
      await requireSession();
      return await postJson('/_auth/bridge/switch-deployment', data);

    case 'confirm_infra':
      await requireSession();
      return await postJson('/_auth/bridge/confirm-infra', { operation: data.operation });

    case 'reset_heartbeat':
      await requireSession();
      return await postJson('/_auth/bridge/reset-heartbeat', {});

    case 'db_status':
      await requireSession();
      return await fetchJson('/_auth/db/status');

    case 'db_info':
      await requireSession();
      return await fetchJson('/_auth/db/info?sandboxId=' + encodeURIComponent(data.sandboxId || ''));

    case 'db_provision':
      await requireSession();
      return await postJson('/_auth/db/provision', { sandboxId: data.sandboxId });

    case 'db_delete':
      await requireSession();
      return await postJson('/_auth/db/delete', { sandboxId: data.sandboxId });

    case 'db_list':
      await requireSession();
      return await fetchJson('/_auth/db/list?sandboxId=' + encodeURIComponent(data.sandboxId || ''));

    case 'db_schema':
      await requireSession();
      return await fetchJson('/_auth/db/schema?sandboxId=' + encodeURIComponent(data.sandboxId || '') + '&database=' + encodeURIComponent(data.database || ''));

    case 'db_query':
      await requireSession();
      return await postJson('/_auth/db/query', { sandboxId: data.sandboxId, sql: data.sql, database: data.database });

    case 'db_execute':
      await requireSession();
      return await postJson('/_auth/db/execute', { sandboxId: data.sandboxId, sql: data.sql, database: data.database });

    case 'db_create':
      await requireSession();
      return await postJson('/_auth/db/create', { sandboxId: data.sandboxId, label: data.label });

    case 'db_drop':
      await requireSession();
      return await postJson('/_auth/db/drop', { sandboxId: data.sandboxId, label: data.label });

    case 'db_assign':
      await requireSession();
      return await postJson('/_auth/db/assign', { sandboxId: data.sandboxId, label: data.label, role: data.role });

    case 'db_backups':
      await requireSession();
      return await fetchJson('/_auth/db/backups?sandboxId=' + encodeURIComponent(data.sandboxId || ''));

    case 'db_backup':
      await requireSession();
      return await postJson('/_auth/db/backup', { sandboxId: data.sandboxId });

    case 'db_restore':
      await requireSession();
      return await postJson('/_auth/db/restore', { sandboxId: data.sandboxId, file: data.file });

    case 'cross_project_list':
      await requireSession();
      return await fetchJson('/_auth/cross-project-access');

    case 'cross_project_grant':
      await requireSession();
      return await postJson('/_auth/cross-project-access', { sandboxId: data.sandboxId, sharedSandboxId: data.sharedSandboxId, sharePreview: !!data.sharePreview });

    case 'cross_project_revoke':
      await requireSession();
      var deleteRes = await fetch('/_auth/cross-project-access', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId: data.sandboxId, sharedSandboxId: data.sharedSandboxId }),
      });
      if (!deleteRes.ok) {
        var deleteErr = await deleteRes.json().catch(function() { return {}; });
        throw new Error(deleteErr.error || 'Request failed');
      }
      return deleteRes.json();

    case 'audit_log':
      await requireSession();
      return await fetchJson('/_auth/audit');

    case 'audit_verify':
      await requireSession();
      return await fetchJson('/_auth/audit/verify');

    case 'secrets_exposures':
      await requireSession();
      return await fetchJson('/_auth/secrets/exposures?sandboxId=' + encodeURIComponent(data.sandboxId || ''));

    case 'secrets_classify':
      await requireSession();
      var classifyRes = await fetch('/_auth/secrets/classify', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyName: data.name, kind: data.kind, sandboxId: data.sandboxId }),
      });
      if (!classifyRes.ok) {
        var classifyErr = await classifyRes.json().catch(function() { return {}; });
        throw new Error(classifyErr.error || 'Request failed');
      }
      return classifyRes.json();

    case 'secrets_acknowledge':
      await requireSession();
      return await postJson('/_auth/secrets/acknowledge', { keyName: data.name, sandboxId: data.sandboxId });

    case 'guardrail_rules':
      await requireSession();
      return await fetchJson('/_auth/guardrail/rules');

    case 'guardrail_proposals':
      await requireSession();
      return await fetchJson('/_auth/guardrail/proposals');

    case 'guardrail_toggle':
      await requireSession();
      return await patchJson('/_auth/guardrail/rules/' + encodeURIComponent(data.id) + '/toggle', { enabled: data.enabled });

    case 'guardrail_delete':
      await requireSession();
      return await deleteJson('/_auth/guardrail/rules/' + encodeURIComponent(data.id));

    case 'guardrail_create':
      await requireSession();
      return await postJson('/_auth/guardrail/rules', data.rule);

    case 'guardrail_proposal_approve':
      await requireSession();
      return await postJson('/_auth/guardrail/proposals/' + encodeURIComponent(data.id) + '/approve', {});

    case 'guardrail_proposal_deny':
      await requireSession();
      return await postJson('/_auth/guardrail/proposals/' + encodeURIComponent(data.id) + '/deny', {});

    case 'watchdog_health':
      await requireSession();
      return await fetchJson('/_auth/bridge/watchdog/health');

    case 'agents_auth_status':
      await requireSession();
      return await fetchJson('/_auth/bridge/agents/auth-status');

    case 'restart_services':
      await requireSession();
      return await postJson('/_auth/bridge/restart-services', {});

    // ── Permission inbox (v2 HITL) ────────────────────────────────────
    case 'permission_list_pending':
      await requireSession();
      return await fetchJson(
        '/_auth/permissions/pending' +
        (data && typeof data.threadId === 'string' && data.threadId
          ? '?threadId=' + encodeURIComponent(data.threadId)
          : ''),
      );

    case 'permission_get':
      await requireSession();
      if (!data || typeof data.id !== 'string' || !data.id) {
        throw new Error('permission_get: id required');
      }
      return await fetchJson('/_auth/permissions/' + encodeURIComponent(data.id));

    case 'permission_history':
      await requireSession();
      if (!data || typeof data.threadId !== 'string' || !data.threadId) {
        throw new Error('permission_history: threadId required');
      }
      return await fetchJson(
        '/_auth/permissions/history?threadId=' + encodeURIComponent(data.threadId),
      );

    case 'permission_mark_seen':
      await requireSession();
      if (!data || typeof data.id !== 'string' || !data.id) {
        throw new Error('permission_mark_seen: id required');
      }
      return await postJson(
        '/_auth/permissions/' + encodeURIComponent(data.id) + '/seen',
        {},
      );

    // ── Gates / context-mode / tool-permission / STS ──────────────────
    // Console origin has no PoP Service Worker (SW is scoped to {srv})
    // so direct fetch from the dashboard returns 401 missing_pop_headers.
    // Routing through the iframe bridge preserves PoP via THIS origin's SW.
    // Operator-signed payloads are passed through unchanged: the operator
    // signature covers the canonical payload string built on the console;
    // the bridge cannot tamper. Each handler runs requireSession() so a
    // logged-out console can't poke shield routes.
    case 'gate_list_active': {
      await requireSession();
      if (!data || typeof data.project !== 'string' || !data.project) {
        throw new Error('gate_list_active: project required');
      }
      // STS scope is required by gates.routes — mint server-side so the
      // token never crosses the bridge boundary.
      var ga_sts = await postJson('/_auth/sts/token', { slug: data.project });
      return await fetchJson('/_auth/gates/active', { 'X-STS-Token': ga_sts.token });
    }

    case 'gate_request': {
      await requireSession();
      if (!data || typeof data.project !== 'string' || !data.project) {
        throw new Error('gate_request: project required');
      }
      if (typeof data.gate !== 'string' || !data.gate) {
        throw new Error('gate_request: gate required');
      }
      var gr_sts = await postJson('/_auth/sts/token', { slug: data.project });
      return await postJson(
        '/_auth/gates/request',
        { gate: data.gate, reason: typeof data.reason === 'string' ? data.reason : '' },
        { 'X-STS-Token': gr_sts.token },
      );
    }

    case 'gate_respond':
      await requireSession();
      if (!data || typeof data.gateRequestId !== 'string' || !data.gateRequestId) {
        throw new Error('gate_respond: gateRequestId required');
      }
      if (typeof data.action !== 'string') {
        throw new Error('gate_respond: action required');
      }
      var gateRespondBody = {
        requestId: data.gateRequestId,
        action: data.action,
        operatorSignature: data.operatorSignature,
        operatorTimestamp: data.operatorTimestamp,
      };
      if (data.metadata !== undefined) gateRespondBody.metadata = data.metadata;
      if (data.intentSignature) gateRespondBody.intentSignature = data.intentSignature;
      if (data.intentNonce) gateRespondBody.intentNonce = data.intentNonce;
      if (data.intentType) gateRespondBody.intentType = data.intentType;
      return await postJson('/_auth/gates/respond', gateRespondBody);

    case 'gate_revoke':
      await requireSession();
      if (!data || typeof data.gate !== 'string' || typeof data.project !== 'string') {
        throw new Error('gate_revoke: gate + project required');
      }
      return await postJson('/_auth/gates/revoke', {
        gate: data.gate,
        project: data.project,
        operatorSignature: data.operatorSignature,
        operatorTimestamp: data.operatorTimestamp,
      });

    case 'gate_set_permission':
      await requireSession();
      if (!data || typeof data.gate !== 'string' || typeof data.project !== 'string') {
        throw new Error('gate_set_permission: gate + project required');
      }
      return await postJson('/_auth/gates/permissions', {
        gate: data.gate,
        project: data.project,
        policy: data.policy,
        operatorSignature: data.operatorSignature,
        operatorTimestamp: data.operatorTimestamp,
      });

    case 'context_mode_get':
      await requireSession();
      if (!data || typeof data.project !== 'string' || !data.project) {
        throw new Error('context_mode_get: project required');
      }
      return await fetchJson(
        '/_auth/context-mode?project=' + encodeURIComponent(data.project),
      );

    case 'context_mode_set':
      await requireSession();
      if (!data || typeof data.project !== 'string' || typeof data.mode !== 'string') {
        throw new Error('context_mode_set: project + mode required');
      }
      return await postJson('/_auth/context-mode', {
        project: data.project,
        mode: data.mode,
        operatorSignature: data.operatorSignature,
        operatorTimestamp: data.operatorTimestamp,
      });

    case 'tool_permission_set':
      await requireSession();
      if (!data || typeof data.connectionId !== 'string' || typeof data.toolName !== 'string'
          || typeof data.permission !== 'string') {
        throw new Error('tool_permission_set: connectionId + toolName + permission required');
      }
      return await postJson('/_auth/tool-permissions', {
        connectionId: data.connectionId,
        toolName: data.toolName,
        permission: data.permission,
        operatorSignature: data.operatorSignature,
        operatorTimestamp: data.operatorTimestamp,
      });

    case 'tool_permission_reset':
      await requireSession();
      if (!data || typeof data.connectionId !== 'string' || typeof data.toolName !== 'string') {
        throw new Error('tool_permission_reset: connectionId + toolName required');
      }
      return await postJson('/_auth/tool-permissions/reset', {
        connectionId: data.connectionId,
        toolName: data.toolName,
        operatorSignature: data.operatorSignature,
        operatorTimestamp: data.operatorTimestamp,
      });

    // ── Operator-key bind ceremony ────────────────────────────────────
    // operator-status is polled on every sandbox/scope switch in console;
    // failing it (direct fetch from console origin → no PoP → 401) caused
    // the AuthWall to flicker on every switch and forced a re-bind.
    case 'gate_operator_status':
      await requireSession();
      return await fetchJson('/_auth/gates/operator-status');

    case 'gate_bind_nonce':
      await requireSession();
      return await fetchJson('/_auth/gates/bind-nonce');

    case 'gate_bind_operator':
      await requireSession();
      // Pass the body through unchanged — shield validates the bind
      // attestation server-side; the bridge cannot forge it.
      if (!data || typeof data !== 'object') {
        throw new Error('gate_bind_operator: body required');
      }
      return await postJson('/_auth/gates/bind-operator', data);

    case 'intent_nonce': {
      await requireSession();
      if (!data || typeof data.action !== 'string' || !data.action) {
        throw new Error('intent_nonce: action required');
      }
      var iqs = 'action=' + encodeURIComponent(data.action);
      if (typeof data.resource === 'string' && data.resource) {
        iqs += '&resource=' + encodeURIComponent(data.resource);
      }
      return await fetchJson('/_auth/intent/nonce?' + iqs);
    }

    // ── AI Tools feature toggles (gbrain / gstack) ──────────────────────
    case 'features_get':
      await requireSession();
      return await fetchJson('/_auth/bridge/features');

    case 'features_toggle':
      await requireSession();
      if (!data || typeof data.feature !== 'string') {
        throw new Error('features_toggle: feature required');
      }
      return await postJson('/_auth/bridge/features/toggle', {
        feature: data.feature,
        enabled: !!data.enabled,
      });

    case 'gbrain_wipe':
      await requireSession();
      return await postJson('/_auth/bridge/features/gbrain-wipe', {});

    case 'tool_provider_set':
      await requireSession();
      if (!data || typeof data.tool !== 'string' || typeof data.provider !== 'string') {
        throw new Error('tool_provider_set: tool and provider required');
      }
      return await postJson('/_auth/bridge/features/tool-provider', {
        tool: data.tool,
        provider: data.provider,
      });

    case 'connector_save_key':
      await requireSession();
      if (!data || typeof data.provider !== 'string' || typeof data.apiKey !== 'string') {
        throw new Error('connector_save_key: provider and apiKey required');
      }
      return await postJson('/_auth/bridge/features/connector-key', {
        provider: data.provider,
        apiKey: data.apiKey,
      });

    case 'connector_remove_key':
      await requireSession();
      if (!data || typeof data.provider !== 'string') {
        throw new Error('connector_remove_key: provider required');
      }
      return await postJson('/_auth/bridge/features/connector-key-remove', {
        provider: data.provider,
      });

    default:
      throw new Error('Unknown message type: ' + type);
  }
}

async function checkSession() {
  // Return cached result if recently validated (prevents hammering /_auth/bridge/session)
  if (session && sessionCheckedAt && (Date.now() - sessionCheckedAt < SESSION_CHECK_TTL)) {
    return true;
  }
  // Deduplicate concurrent calls — share a single in-flight request
  if (pendingSessionCheck) return pendingSessionCheck;
  pendingSessionCheck = (async () => {
    try {
      const res = await fetch('/_auth/bridge/session', { credentials: 'include' });
      if (res.ok) {
        session = await res.json();
        sessionCheckedAt = Date.now();
        return true;
      }
    } catch {}
    session = null;
    sessionCheckedAt = 0;
    return false;
  })();
  try { return await pendingSessionCheck; } finally { pendingSessionCheck = null; }
}

async function requireSession() {
  // Standard tier uses JWT cookies, not browser sessions.
  // The JWT cookie is already present on this iframe's origin
  // and the VPS endpoints validate it directly — no session or PoP needed.
  if (SECURITY_TIER === 'standard') {
    return;
  }
  if (pendingAuth) {
    await pendingAuth;
    return;
  }
  if (session) {
    if (!popReady) {
      try { await initPoP(); } catch (e) { console.warn('[Bridge] PoP init failed:', e.message); }
    }
    return;
  }
  const hasSession = await checkSession();
  if (hasSession) {
    if (!popReady) {
      try { await initPoP(); } catch (e) { console.warn('[Bridge] PoP init failed:', e.message); }
    }
    return;
  }
  // Don't auto-trigger passkey auth - let the dashboard show an auth wall
  // The user must explicitly click "Login with Passkey" to authenticate
  throw new Error('Authentication required');
}

async function fetchKeys() {
  const res = await fetch('/_auth/bridge/keys', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch keys');
  return res.json();
}

async function addKey(name, publicKey) {
  const res = await fetch('/_auth/keys', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, publicKey }),
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to add key');
  }
  return res.json();
}

async function removeKey(fingerprint) {
  const res = await fetch('/_auth/keys/' + encodeURIComponent(fingerprint), {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to remove key');
  }
  return { fingerprint };
}

async function fetchPasskeys() {
  const res = await fetch('/_auth/bridge/passkeys', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to fetch passkeys');
  return res.json();
}

async function switchTier(targetTier) {
  const res = await fetch('/_auth/bridge/switch-tier', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetTier }),
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to switch tier');
  }
  return res.json();
}

async function registerPasskey(name) {
  // WebAuthn registration MUST happen in a top-level window, not a cross-origin iframe.
  // Safari/WebKit blocks navigator.credentials.create() when the iframe origin
  // doesn't match the address bar origin. Return a popup URL for the console to open.
  const encodedName = encodeURIComponent(name || 'Passkey');
  return {
    requiresPopup: true,
    popupUrl: '/_auth/standard-upgrade?name=' + encodedName,
    message: 'Open popup to register passkey'
  };
}

async function removePasskey(credentialId) {
  const res = await fetch('/_auth/bridge/passkey/' + encodeURIComponent(credentialId), {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to remove passkey');
  }
  return { credentialId };
}

async function upgradeToWebLocked(name) {
  // WebAuthn registration requires user activation and can't work in cross-origin iframe
  // Return a popup URL for the dashboard to open
  const encodedName = encodeURIComponent(name || 'Passkey');
  return {
    requiresPopup: true,
    popupUrl: '/_auth/standard-upgrade?name=' + encodedName,
    message: 'Open popup to register passkey'
  };
}

async function downgradeToStandard() {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch('/_auth/bridge/downgrade-to-standard', {
      method: 'POST',
      credentials: 'include',
    });
    if (res.ok) return res.json();
    const error = await res.json().catch(() => ({}));

    if (res.status === 401 && (error.reason === 'step_up_required' || attempt === 1)) {
      const recovered = await attemptSessionRecovery();
      if (recovered) continue;
      throw new Error('Session expired. Please re-authenticate.');
    }
    throw new Error(error.error || 'Failed to downgrade to Standard');
  }
  throw new Error('Failed to downgrade after re-auth');
}

async function switchToWebLocked(name) {
  const tierInfo = await getCurrentTierInfo();
  if (!session && tierInfo.passkeys.length > 0) {
    throw new Error('Authentication required');
  }
  if (tierInfo.passkeys.length === 0) {
    await registerPasskey(name);
  }
  const res = await fetch('/_auth/bridge/switch-tier', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetTier: 'web_locked' }),
  });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to switch to Web Locked');
  }
  return { tier: 'web_locked' };
}

async function getCurrentTierInfo() {
  const res = await fetch('/_auth/bridge/tier', { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to get tier info');
  return res.json();
}

async function confirmOperation(operation) {
  // VALID_OPERATIONS is substituted at serve time by static.routes.ts
  // from the shared TS source in packages/vps/src/auth/valid-operations.ts.
  // Do NOT hand-edit this array — it will drift.
  const VALID_OPERATIONS = __VALID_OPERATIONS__;
  if (!operation || !VALID_OPERATIONS.includes(operation)) {
    throw new Error('Invalid operation. Must be one of: ' + VALID_OPERATIONS.join(', '));
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch('/_auth/confirm-operation', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation }),
    });
    if (res.ok) {
      return await res.json();
    }
    const error = await res.json().catch(() => ({}));

    // Session expired — attempt centralized recovery (popup re-auth)
    if (res.status === 401 && attempt === 1) {
      const recovered = await attemptSessionRecovery();
      if (recovered) continue; // Retry the confirm-operation
      throw new Error('Session expired. Please re-authenticate.');
    }

    if (error.reason === 'pop_not_bound' && attempt < 3) {
      if (!popReady) {
        try { await initPoP(); } catch (e) { console.warn('[Bridge] PoP init failed:', e.message); }
      }
      await new Promise(r => setTimeout(r, 500 * attempt));
      continue;
    }
    if (error.needsAuth) {
      throw new Error('Authentication required');
    }
    throw new Error(error.error || 'Failed to confirm operation');
  }
  throw new Error('Failed to confirm operation after retries');
}

/**
 * Request re-authentication from the console.
 * Sends 'auth_required' postMessage to parent. The console does native passkey
 * auth (inline Touch ID/Face ID) via get_auth_options/verify_auth, then signals
 * 'auth_completed' when done. Falls back to exchange_session from popup if native fails.
 */
function requestReauthFromConsole(operation) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Re-auth timeout'));
    }, 120000); // 2 minute timeout for user to complete passkey

    function handler(event) {
      if (!PARENT_ORIGIN || event.origin !== PARENT_ORIGIN) return;
      // Native auth completed — session already set via verify_auth handler
      if (event.data?.type === 'auth_completed') {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        resolve(event.data.success ? 'native' : null);
      }
      // Fallback: popup exchange flow (if native auth isn't available)
      if (event.data?.type === 'exchange_session') {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        // Exchange the code for a session cookie
        fetch('/_auth/session/exchange', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exchangeCode: event.data.exchangeCode }),
        }).then(function(res) {
          if (res.ok) {
            session = null;
            sessionCheckedAt = 0;
            popReady = false;
            initPoP().catch(function() {});
            checkSession().then(function() { resolve('exchange'); });
          } else {
            resolve(null);
          }
        }).catch(function() { resolve(null); });
      }
      if (event.data?.type === 'exchange_cancelled') {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        resolve(null);
      }
    }

    window.addEventListener('message', handler);

    // Signal console to do native auth (or fallback to popup)
    if (PARENT_ORIGIN) {
      window.parent.postMessage({
        type: 'auth_required',
        operation,
      }, PARENT_ORIGIN);
    } else {
      clearTimeout(timeout);
      reject(new Error('No parent origin'));
    }
  });
}

async function authorizeGitLink(repoFullName, provider) {
  if (!repoFullName || !provider) {
    throw new Error('repoFullName and provider are required');
  }
  const res = await fetch('/_auth/git/authorize-link', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoFullName, provider }),
  });
  if (!res.ok) {
    const error = await res.json();
    if (error.needsAuth) {
      throw new Error('Authentication required');
    }
    throw new Error(error.error || 'Failed to authorize git link');
  }
  return res.json();
}

async function authorizeGitUnlink() {
  const res = await fetch('/_auth/git/authorize-unlink', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const error = await res.json();
    if (error.needsAuth) {
      throw new Error('Authentication required');
    }
    throw new Error(error.error || 'Failed to authorize git unlink');
  }
  return res.json();
}

async function setSecretViaApi(data) {
  if (!data.name || !data.iv || !data.encryptedData) {
    throw new Error('Missing required fields: name, iv, encryptedData');
  }
  // Forward entire envelope — supports both legacy (encryptedKey) and PQC (_pqc, x25519_eph_pub, mlkem_ct)
  const body = { ...data };
  const res = await fetch('/_auth/secrets', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to set secret');
  }
  return res.json();
}

async function deleteSecretViaApi(name, sandboxId) {
  if (!name) throw new Error('Missing secret name');
  const query = sandboxId ? '?sandboxId=' + encodeURIComponent(sandboxId) : '';
  const res = await fetch('/_auth/secrets/' + encodeURIComponent(name) + query, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to delete secret');
  }
  return res.json();
}

async function listSecretsViaApi(sandboxId, env) {
  const params = new URLSearchParams();
  if (sandboxId) params.set('sandboxId', sandboxId);
  if (env) params.set('env', env);
  const query = params.toString() ? '?' + params.toString() : '';
  const res = await fetch('/_auth/secrets' + query, { credentials: 'include' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to list secrets');
  }
  return res.json();
}

async function readSecretValuesViaApi(sandboxId, env) {
  const params = new URLSearchParams();
  if (sandboxId) params.set('sandboxId', sandboxId);
  if (env) params.set('env', env);
  const query = params.toString() ? '?' + params.toString() : '';
  const res = await fetch('/_auth/secrets/values' + query, { credentials: 'include' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to read secret values');
  }
  return res.json();
}

async function setSecretsBulkViaApi(secrets, sandboxId) {
  if (!Array.isArray(secrets) || secrets.length === 0) {
    throw new Error('secrets must be a non-empty array');
  }
  const body = { secrets };
  if (sandboxId) body.sandboxId = sandboxId;
  const res = await fetch('/_auth/secrets/bulk', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(error.error || 'Failed to set secrets');
  }
  return res.json();
}

function respond(requestId, data) {
  if (!PARENT_ORIGIN) return;
  try { parent.postMessage({ requestId, ...data }, PARENT_ORIGIN); } catch {}
}

// Send message to parent - prefer captured PARENT_ORIGIN to avoid postMessage mismatches
function notifyParent(data) {
  if (PARENT_ORIGIN) {
    try { parent.postMessage(data, PARENT_ORIGIN); } catch {}
  } else {
    // Fallback: try all known origins if referrer wasn't captured
    DASHBOARD_ORIGINS.forEach(origin => {
      try { parent.postMessage(data, origin); } catch {}
    });
  }
}

// Initialize: check session first, then PoP for web_locked tier
if (SECURITY_TIER !== 'standard') {
  (async () => {
    // Check for valid session before attempting PoP bind
    const hasSession = await checkSession();
    if (!hasSession) {
      notifyParent({ type: 'bridge_ready', pop: false, error: 'No session' });
      return;
    }
    await initPoP();
    notifyParent({ type: 'bridge_ready', pop: true });
  })().catch((err) => {
    console.error('[Bridge] Initialization failed:', err);
    notifyParent({
      type: 'bridge_ready',
      pop: false,
      error: err.message || 'pop_init_failed'
    });
  });
} else {
  // Standard: no PoP needed, bridge is immediately ready
  notifyParent({ type: 'bridge_ready', pop: true });
}

// Session expiry detection moved server-side: file-api pushes `session_status`
// frames over the console's shared WebSocket (from localhost poll of the
// shield's /_auth/code/session/status endpoint). The console reacts through
// the session-events bus in vps-bridge.tsx, which triggers the same re-auth
// flow this poll used to. Net effect: zero idle HTTP traffic through
// Cloudflare, while preserving proactive expiry detection.
//
// The explicit `session_keepalive` postMessage handler above is still wired
// for callers that need an on-demand liveness check (e.g. right before a
// sensitive operation). Only the periodic background poll is removed.
