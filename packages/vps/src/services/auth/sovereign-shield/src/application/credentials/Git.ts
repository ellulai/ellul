// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Git Service
 *
 * Execute git operations (push, pull, setup, teardown) on the VPS.
 * Ported from enforcer handle_git_action() in enforcement.sh.
 *
 * SECURITY: Git credentials are stored only in sovereign-shield's process
 * memory (via git-credentials.service). All git operations that require
 * remote access create a short-lived credential session, which is passed
 * to the subprocess via GIT_CREDENTIAL_SESSION env var. The credential
 * helper reads this var and calls back to sovereign-shield to get creds.
 *
 * The agent CANNOT:
 * - Read git tokens from env files (they're not there — stored in memory only)
 * - Create credential sessions (in-process only, no HTTP endpoint)
 * - Push without a gate token (which requires browser button press)
 *
 * Called via bridge endpoint (passkey-authenticated).
 */

import { execSync, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import { API_URL_FILE } from '../../config';
import { setGitCredentialEncrypted, type HybridKemEncryptedEnvelope } from '../vault/Secrets';
import { isGitSecret } from './GitCredentials';
import { createActionGate } from '../../routes/workflow.routes';
import {
  // ELLUL_CO_AUTHOR,  // TODO: Uncomment once GitHub account with dev@ellul.ai is created
  createCredentialSession,
  deleteCredentialSession,
  getGitEnvVars,
  deleteAllGitSecrets,
  resolveProjectDir,
  buildAppSuffix,
  safeGitCmd,
} from './GitCredentials';

export type GitAction = 'push' | 'pull' | 'force-push' | 'setup' | 'teardown';

const ACTIVE_GIT_APP_FILE = '/etc/ellul/shield-data/.active-git-app';

/**
 * Pull all encrypted secrets from the API and decrypt them.
 * Git secrets go to in-memory store; others go to env file.
 *
 * Single attempt, non-blocking. Called via setTimeout(5s) after shield starts.
 * By that time, boot-config has written ai-proxy-token. If the token or API
 * call fails, it logs a warning — the git token refresh timer (30min) will
 * retry later. No blocking sleeps that freeze the event loop.
 */
export function syncSecretsFromApi(): void {
  let apiUrl: string;
  let bearerToken: string;

  try {
    apiUrl = fs.readFileSync(API_URL_FILE, 'utf8').trim();
  } catch {
    return;
  }

  try {
    bearerToken = fs.readFileSync('/etc/ellul-bootstrap/ai-proxy-token', 'utf8').trim();
  } catch {
    return;
  }

  if (!bearerToken) return;

  try {
    const url = `${apiUrl}/api/servers/secrets/sync`;
    const result = execFileSync(
      'curl',
      ['-s', '-f', '-m', '10', '-H', `Authorization: Bearer ${bearerToken}`, url],
      { timeout: 15_000, encoding: 'utf8' },
    );

    const data = JSON.parse(result);
    if (data.secrets && Array.isArray(data.secrets) && data.secrets.length > 0) {
      // This sync endpoint carries git credentials only — regular sandbox
      // secrets are set via the browser-authenticated
      // `POST /_auth/secrets` route, which always carries an explicit
      // `sandboxId`. The API's envelope payload has no sandbox tag, so
      // routing anything non-git here would violate the sandbox-scoped
      // invariant. Any non-`__GIT_*` entries from legacy API responses
      // are skipped with a warning.
      let synced = 0;
      let skipped = 0;
      for (const s of data.secrets as any[]) {
        const hasX25519 = s.x25519_eph_pub || s.x25519EphPub;
        const hasMlkem = s.mlkem_ct || s.encryptedKey;
        if (!hasX25519 || !hasMlkem || !s.iv || !s.encryptedData) continue;
        if (!isGitSecret(s.name)) {
          skipped += 1;
          continue;
        }
        const envelope: HybridKemEncryptedEnvelope = {
          _e2ee: true,
          _pqc: 3,
          x25519_eph_pub: s.x25519_eph_pub || s.x25519EphPub,
          mlkem_ct: s.mlkem_ct || s.encryptedKey,
          iv: s.iv,
          encryptedData: s.encryptedData,
        };
        setGitCredentialEncrypted(s.name, envelope);
        synced += 1;
      }
      if (synced > 0) console.log(`[shield] Synced ${synced} git credentials from API`);
      if (skipped > 0) {
        console.warn(
          `[shield] Sync skipped ${skipped} non-git secrets — the sync endpoint does not carry sandbox scope`,
        );
      }
    }
  } catch (err: any) {
    console.warn('[shield] Secrets sync from API failed:', err.message);
  }
}

/**
 * Async exec — runs a shell script without blocking the event loop.
 * CRITICAL: Must be used instead of execSync for any git operation that
 * triggers the credential helper, because the helper calls back to this
 * server and execSync would deadlock.
 *
 * SECURITY: The script argument is a static string literal — never interpolate
 * user/dynamic values into it. Pass dynamic values as positional arguments via
 * the `args` array, referenced in the script as $1, $2, etc. This prevents
 * shell injection regardless of what the values contain.
 */
function execAsync(
  script: string,
  args: string[],
  opts?: { timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    // bash -c 'script' _ arg1 arg2  — the _ is $0, arg1 is $1, etc.
    const proc = spawn('bash', ['-c', script, '_', ...args], {
      env: opts?.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = opts?.timeout ? setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, opts.timeout) : null;

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (killed) {
        reject(new Error('Command timed out'));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        const err = new Error(stderr || stdout || `Process exited with code ${code}`);
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        reject(err);
      }
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Execute a git action on the VPS.
 *
 * All remote git operations use credential sessions — the credential helper
 * calls back to sovereign-shield to get credentials instead of reading from disk.
 *
 * NOTE: Remote git operations (setup, push, pull) use execAsync instead of
 * execSync to avoid deadlocking the event loop — the credential helper calls
 * back to this server during git operations.
 */
export async function executeGitAction(action: GitAction, sandboxId?: string): Promise<{ success: boolean; output?: string }> {
  // Resolve active app from file if not provided
  let activeApp = sandboxId;
  if (!activeApp) {
    try {
      activeApp = fs.readFileSync(ACTIVE_GIT_APP_FILE, 'utf8').trim();
    } catch {
      activeApp = undefined;
    }
  }

  const projectDir = resolveProjectDir(activeApp);
  const appSuffix = (activeApp && activeApp !== 'null' && activeApp !== 'default')
    ? buildAppSuffix(activeApp)
    : '';

  // Persist active git app
  if (activeApp && activeApp !== 'null') {
    fs.writeFileSync(ACTIVE_GIT_APP_FILE, activeApp);
    try { fs.chmodSync(ACTIVE_GIT_APP_FILE, 0o644); } catch {}
  }

  // Create credential session for remote git operations
  const credSession = createCredentialSession(appSuffix);

  // Build subprocess environment:
  // - GIT_CREDENTIAL_SESSION: for the credential helper to call back to sovereign-shield
  // - Git env vars: for scripts that read them for validation/config (e.g. git-setup)
  // - Existing process env: for PATH, HOME, etc.
  // - GIT_CONFIG_NOSYSTEM/GLOBAL: ignore /etc/gitconfig and ~/.gitconfig so any
  //   writes shield-runner's home may contain cannot affect remote operations.
  //   Repo-local .git/config is still read (by design — branch state lives there);
  //   cross-host credential issuance is prevented by the helper's host-binding
  //   check rather than by trying to ignore .git/config entirely.
  const gitEnv = getGitEnvVars(appSuffix);
  const subEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    GIT_CREDENTIAL_SESSION: credSession,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...gitEnv,
  };

  try {
    // NOTE: sovereign-shield already runs as SVC_USER (systemd User=dev).
    // Do NOT use sudo — the systemd unit has NoNewPrivileges=true which blocks it.
    switch (action) {
      case 'setup': {
        if (!fs.existsSync('/usr/local/bin/ellul-git-setup')) {
          return { success: false, output: 'ellul-git-setup not found' };
        }
        // Sync secrets from API (git secrets go to memory, others to env file)
        syncSecretsFromApi();
        // Re-create credential session with fresh secrets
        deleteCredentialSession(credSession);
        const freshSession = createCredentialSession(appSuffix);
        const freshGitEnv = getGitEnvVars(appSuffix);
        const setupEnv: Record<string, string> = {
          ...process.env as Record<string, string>,
          GIT_CREDENTIAL_SESSION: freshSession,
          ...freshGitEnv,
          ELLUL_PROJECT_DIR: projectDir,
        };
        try {
          const output = await execAsync(
            '/usr/local/bin/ellul-git-setup',
            [],
            { timeout: 60_000, env: setupEnv },
          );
          return { success: true, output };
        } finally {
          deleteCredentialSession(freshSession);
        }
      }

      case 'push': {
        const gateToken = createActionGate('git-push', activeApp || 'unknown');
        const pushEnv = { ...subEnv, GIT_PUSH_TOKEN: gateToken };
        const sgit = safeGitCmd();
        // SECURITY: $1 = projectDir, $2 = safeGitCmd prefix — never interpolated
        // into shell. Every git invocation (add/diff/commit/push) uses $2 so
        // hooks are disabled throughout — a pre-commit hook planted in
        // .git/hooks/ cannot run with credentials in its env.
        const output = await execAsync(
          // TODO: Uncomment -m trailer once GitHub account with dev@ellul.ai is created
          'cd -- "$1" && $2 add -A && { $2 diff --cached --quiet && echo "Nothing to commit" || $2 commit -m "Backup from ellul ($(date "+%Y-%m-%d %H:%M"))"; } && $2 push -u origin HEAD 2>&1',
          [projectDir, sgit],
          { timeout: 120_000, env: pushEnv },
        );
        return { success: true, output };
      }

      case 'force-push': {
        const gateToken = createActionGate('git-push', activeApp || 'unknown');
        const pushEnv = { ...subEnv, GIT_PUSH_TOKEN: gateToken };
        const sgit = safeGitCmd();
        const output = await execAsync(
          // TODO: Uncomment -m trailer once GitHub account with dev@ellul.ai is created
          'cd -- "$1" && $2 add -A && { $2 diff --cached --quiet || $2 commit -m "Backup from ellul ($(date "+%Y-%m-%d %H:%M"))"; } && $2 push -u origin HEAD --force-with-lease 2>&1',
          [projectDir, sgit],
          { timeout: 120_000, env: pushEnv },
        );
        return { success: true, output };
      }

      case 'pull': {
        // SECURITY: Split into fetch + rebase to prevent trojan hook attacks.
        // - fetch is read-only at git protocol level (cannot push)
        // - credential session is deleted before rebase (local op, no creds needed)
        // - EVERY git call goes through $2 = safeGitCmd which disables hooks.
        //   Missing the wrapper on any step (rebase, stash, stash pop) would
        //   let a planted .git/hooks/post-rewrite run under shield-runner; the
        //   credential session is already gone by then, but the hook could
        //   still mutate repo state that rides along on the next push.
        const sgit = safeGitCmd();
        await execAsync(
          'cd -- "$1" && $2 fetch origin 2>&1',
          [projectDir, sgit],
          { timeout: 120_000, env: subEnv },
        );
        // Kill credential session before local rebase
        deleteCredentialSession(credSession);

        const branch = execFileSync(
          'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
          { timeout: 5_000, encoding: 'utf8', cwd: projectDir },
        ).trim();
        // SECURITY: Validate branch name — reject anything that isn't a safe git ref.
        // Also reject '..' which is a path-traversal in ref form.
        if (!/^[a-zA-Z0-9\/_.-]+$/.test(branch) || branch.includes('..')) {
          return { success: false, output: `Invalid branch name: ${branch}` };
        }
        // Stash any dirty working tree so rebase can proceed.
        // subEnv still passed to keep NOSYSTEM/GLOBAL, but no credential session.
        const localEnv = { ...subEnv, GIT_CREDENTIAL_SESSION: '' };
        const stashResult = await execAsync(
          'cd -- "$1" && $2 stash 2>&1',
          [projectDir, sgit],
          { timeout: 10_000, env: localEnv },
        );
        const didStash = !stashResult.includes('No local changes');
        try {
          const output = await execAsync(
            'cd -- "$1" && $2 rebase "origin/$3" 2>&1',
            [projectDir, sgit, branch],
            { timeout: 60_000, env: localEnv },
          );
          return { success: true, output };
        } finally {
          if (didStash) {
            try { await execAsync('cd -- "$1" && $2 stash pop 2>&1', [projectDir, sgit], { timeout: 10_000, env: localEnv }); } catch {}
          }
        }
      }

      case 'teardown': {
        try {
          execFileSync('git', ['remote', 'remove', 'origin'], { timeout: 10_000, cwd: projectDir, stdio: 'pipe' });
        } catch {}
        try {
          execFileSync('git', ['config', '--global', '--unset', 'credential.helper'], { timeout: 10_000, stdio: 'pipe' });
        } catch {}
        try { fs.unlinkSync(ACTIVE_GIT_APP_FILE); } catch {}
        // Clear git secrets from memory
        deleteAllGitSecrets();
        return { success: true };
      }

      default:
        return { success: false, output: `Unknown git action: ${action}` };
    }
  } finally {
    deleteCredentialSession(credSession);
  }
}
