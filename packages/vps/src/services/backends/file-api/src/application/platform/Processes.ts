// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Processes Service

import { execSync } from 'child_process';
import { RESERVED_PORTS } from '@vps/shared/constants';
import { IS_ANDROID } from '@vps/shared/platform';

// Kill result for a single port.
export interface KillResult {
  port: number;
  status: 'killed' | 'failed';
  error?: string;
}

// Kill processes on specified ports.
export function killProcessesOnPorts(ports: number[]): {
  success: boolean;
  results: KillResult[];
  error?: string;
} {
  // Filter out system ports
  const safePorts = ports.filter((p) => {
    const port = parseInt(String(p), 10);
    return !isNaN(port) && port > 0 && port < 65536 && !RESERVED_PORTS.has(port);
  });

  if (safePorts.length === 0) {
    return { success: false, results: [], error: 'No valid user ports to kill' };
  }

  const results: KillResult[] = [];
  for (const port of safePorts) {
    try {
      execSync(`fuser -k -n tcp ${port} 2>/dev/null || true`, { timeout: 5000 });
      results.push({ port, status: 'killed' });
    } catch (e) {
      const error = e as Error;
      results.push({ port, status: 'failed', error: error.message });
    }
  }

  console.log(`[kill-ports] Killed processes on ports: ${safePorts.join(', ')}`);
  return { success: true, results };
}

// Restart essential services.
export function restartServices(tier: string): {
  success: boolean;
  agentBridge: boolean;
  ttyd: boolean;
  tier: string;
} {
  const results = { agentBridge: false, ttyd: false, tier, success: true };
  if (IS_ANDROID) return results;

  try {
    execSync(
      'sudo systemctl restart ellul-agent-bridge 2>/dev/null || sudo systemctl start ellul-agent-bridge',
      { stdio: 'ignore' }
    );
    results.agentBridge = true;
    if (tier === 'standard' || tier === 'web_locked' || tier === 'private_locked') {
      // Dynamic terminal sessions are handled by term-proxy (not static ttyd services)
      execSync('sudo systemctl restart ellul-term-proxy 2>/dev/null || sudo systemctl start ellul-term-proxy', {
        stdio: 'ignore',
      });
      results.ttyd = true; // Renamed for backwards compatibility, actually refers to term-proxy now
    }
  } catch {
    results.success = false;
  }

  return results;
}
