// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Gates: agent requests, operator SLH-DSA signature approves (domain-separated).
// Auto-close on TTL/restart (fail-closed). Policies: ask | allow_always | deny_always.

import * as crypto from 'crypto';
import {
  verifyOperatorSignature,
  gateApprovePayload,
  gateDenyPayload,
  policySetPayload,
} from '../crypto/index';
import type { GateType } from './capability-allowlist';

// ── Types ──

export type GatePolicy = 'ask' | 'allow_always' | 'deny_always';

export interface GateState {
  gate: GateType;
  open: boolean;
  policy: GatePolicy;
  openedAt: number | null;
  expiresAt: number | null;
  /** Duration in seconds that was approved (for display). */
  approvedDuration: number | null;
}

export interface GateRequest {
  requestId: string;
  gate: GateType;
  project: string;
  reason: string;
  requestedAt: number;
}

// ── Default gate TTLs (seconds) ──

const DEFAULT_TTLS: Record<GateType, number> = {
  test: 300,    // 5 minutes
  build: 300,
  lint: 300,
  dev: 3600,    // 1 hour (dev servers run long)
  exec: 300,
};

// ── Gate Manager ──

export class LocalGateManager {
  /** Per-project gate states. Key: `${project}:${gate}` */
  private states = new Map<string, GateState>();

  /** Pending gate requests (waiting for human approval). Key: requestId */
  private pendingRequests = new Map<string, GateRequest>();

  /** Expiry timers. Key: `${project}:${gate}` */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Persistent policies. Key: `${project}:${gate}` */
  private policies = new Map<string, GatePolicy>();

  /** Callback for surfacing gate requests to REPL. Set by daemon. */
  onGateRequest: ((req: GateRequest) => void) | null = null;

  private operatorPublicKey: string;

  constructor(operatorPublicKey: string) {
    this.operatorPublicKey = operatorPublicKey;
  }

  // ── State Accessors ──

  private key(project: string, gate: GateType): string {
    return `${project}:${gate}`;
  }

  private getOrCreateState(project: string, gate: GateType): GateState {
    const k = this.key(project, gate);
    let state = this.states.get(k);
    if (!state) {
      state = {
        gate,
        open: false,
        policy: this.policies.get(k) || 'ask',
        openedAt: null,
        expiresAt: null,
        approvedDuration: null,
      };
      this.states.set(k, state);
    }
    return state;
  }

  // ── Gate Operations ──

  /**
   * Agent requests a gate to be opened.
   * Returns a requestId. The request is forwarded to the REPL for human approval.
   * If policy is allow_always, auto-approves immediately.
   * If policy is deny_always, auto-denies immediately.
   */
  requestGate(gate: GateType, project: string, reason: string): {
    requestId: string;
    status: 'pending' | 'auto_approved' | 'auto_denied' | 'already_open';
  } {
    const state = this.getOrCreateState(project, gate);

    // Already open?
    if (state.open) {
      return { requestId: '', status: 'already_open' };
    }

    // Auto-deny?
    if (state.policy === 'deny_always') {
      return { requestId: '', status: 'auto_denied' };
    }

    // Auto-approve?
    if (state.policy === 'allow_always') {
      this.openGate(project, gate, DEFAULT_TTLS[gate]);
      return { requestId: '', status: 'auto_approved' };
    }

    // Create pending request
    const requestId = crypto.randomBytes(8).toString('hex');
    const request: GateRequest = {
      requestId,
      gate,
      project,
      reason,
      requestedAt: Date.now(),
    };
    this.pendingRequests.set(requestId, request);

    // Surface to REPL
    if (this.onGateRequest) {
      this.onGateRequest(request);
    }

    return { requestId, status: 'pending' };
  }

  /**
   * Operator approves a gate. Requires valid SLH-DSA signature.
   *
   * @param gate - Gate type to approve
   * @param project - Project slug
   * @param durationSeconds - How long to keep the gate open (0 = session)
   * @param signatureBase64 - SLH-DSA signature over domain-separated payload
   * @param timestampStr - Timestamp that was included in the signature
   * @returns true if approved, false if signature verification failed
   */
  async approveGate(
    gate: GateType,
    project: string,
    durationSeconds: number,
    signatureBase64: string,
    timestampStr: string,
  ): Promise<boolean> {
    const payload = gateApprovePayload(gate, project, durationSeconds);
    const valid = await verifyOperatorSignature(
      this.operatorPublicKey, payload, signatureBase64, timestampStr,
    );

    if (!valid) return false;

    this.openGate(project, gate, durationSeconds || null);

    // Clear any pending requests for this gate
    for (const [id, req] of this.pendingRequests) {
      if (req.gate === gate && req.project === project) {
        this.pendingRequests.delete(id);
      }
    }

    return true;
  }

  /**
   * Operator denies a gate. Requires valid SLH-DSA signature.
   */
  async denyGate(
    gate: GateType,
    project: string,
    signatureBase64: string,
    timestampStr: string,
  ): Promise<boolean> {
    const payload = gateDenyPayload(gate, project);
    const valid = await verifyOperatorSignature(
      this.operatorPublicKey, payload, signatureBase64, timestampStr,
    );

    if (!valid) return false;

    // Close the gate if open
    this.closeGate(project, gate);

    // Clear pending requests
    for (const [id, req] of this.pendingRequests) {
      if (req.gate === gate && req.project === project) {
        this.pendingRequests.delete(id);
      }
    }

    return true;
  }

  /**
   * Set a persistent gate policy. Requires operator signature.
   */
  async setPolicy(
    gate: GateType,
    policy: GatePolicy,
    project: string,
    signatureBase64: string,
    timestampStr: string,
  ): Promise<boolean> {
    const payload = policySetPayload(gate, policy, project);
    const valid = await verifyOperatorSignature(
      this.operatorPublicKey, payload, signatureBase64, timestampStr,
    );

    if (!valid) return false;

    const k = this.key(project, gate);
    this.policies.set(k, policy);

    // Update active state
    const state = this.getOrCreateState(project, gate);
    state.policy = policy;

    return true;
  }

  /** Check if a gate is currently open. */
  isGateOpen(gate: GateType, project: string): boolean {
    const state = this.states.get(this.key(project, gate));
    return state?.open === true;
  }

  /** Get all gate states for a project. */
  getGateStates(project: string): GateState[] {
    const gates: GateType[] = ['test', 'build', 'lint', 'dev', 'exec'];
    return gates.map(g => this.getOrCreateState(project, g));
  }

  /** Get all pending requests. */
  getPendingRequests(): GateRequest[] {
    return [...this.pendingRequests.values()];
  }

  // ── Internal State Management ──

  private openGate(project: string, gate: GateType, durationSeconds: number | null): void {
    const k = this.key(project, gate);
    const state = this.getOrCreateState(project, gate);
    state.open = true;
    state.openedAt = Date.now();
    state.approvedDuration = durationSeconds;

    // Clear existing timer
    const existingTimer = this.timers.get(k);
    if (existingTimer) clearTimeout(existingTimer);

    if (durationSeconds && durationSeconds > 0) {
      state.expiresAt = Date.now() + durationSeconds * 1000;
      const timer = setTimeout(() => {
        this.closeGate(project, gate);
      }, durationSeconds * 1000);
      timer.unref(); // Don't prevent process exit
      this.timers.set(k, timer);
    } else {
      // Session-scoped: no timer, closes on daemon restart
      state.expiresAt = null;
    }
  }

  private closeGate(project: string, gate: GateType): void {
    const k = this.key(project, gate);
    const state = this.states.get(k);
    if (state) {
      state.open = false;
      state.openedAt = null;
      state.expiresAt = null;
      state.approvedDuration = null;
    }
    const timer = this.timers.get(k);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(k);
    }
  }

  /** Dispose all timers (for graceful shutdown). */
  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.states.clear();
    this.pendingRequests.clear();
  }
}
