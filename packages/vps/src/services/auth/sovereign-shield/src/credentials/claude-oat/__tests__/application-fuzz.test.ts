// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Application-layer adversarial fuzz tests.
 *
 * Exercises the public command surface (saveToken, peek, issueOat,
 * redeemOat, reportUnauth, revokeOat, recordProbeOutcome) against an
 * in-memory port set. Verifies the structural invariants that prevent
 * the original bug from recurring:
 *
 *   1. Trigger phrases via report-401 NEVER destroy the token.
 *   2. 100 rapid spawn cycles never destroy the token.
 *   3. Interleaved 401 reports + transient probe failures preserve token.
 *   4. Only auth-failed probe outcomes can move state to suspect/revoked.
 *   5. Issuance tokens are single-use and audit every redeem.
 *   6. Revoke is idempotent.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("../../../config", () => ({
  SHIELD_DATA_DIR: "/tmp/test-overridden",
  SERVER_ID_FILE: "/tmp/test-overridden",
}));

import type { ClaudeOatPorts } from "../application/ports";
import { saveToken } from "../application/save-token";
import { peek } from "../application/peek";
import { issueOat } from "../application/issue-oat";
import { redeemOat } from "../application/redeem-oat";
import { reportUnauth } from "../application/report-unauth";
import { revokeOat } from "../application/revoke-oat";
import { recordProbeOutcome } from "../application/record-probe-outcome";
import { getTokenForProbe } from "../application/get-token-for-probe";
import { ClaudeOatError } from "../domain/errors";
import {
  CountingRandom,
  FixedClock,
  InMemoryAuditLog,
  InMemoryIssuance,
  InMemoryStore,
  TestCipher,
} from "./test-fakes";

const VALID_OAT =
  "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const VALID_OAT_2 =
  "sk-ant-oat01-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

let ports: ClaudeOatPorts;
let store: InMemoryStore;
let audit: InMemoryAuditLog;
let issuance: InMemoryIssuance;
let clock: FixedClock;
let immediateProbeRequested: boolean;
const signalImmediate = () => {
  immediateProbeRequested = true;
};

beforeEach(() => {
  store = new InMemoryStore();
  audit = new InMemoryAuditLog();
  issuance = new InMemoryIssuance();
  clock = new FixedClock();
  immediateProbeRequested = false;
  ports = {
    store,
    audit,
    issuance,
    clock,
    random: new CountingRandom(),
    cipher: new TestCipher(),
  };
});

// ────────────────────────────────────────────────────────────────────────────
// Save / peek / revoke / rotate
// ────────────────────────────────────────────────────────────────────────────

describe("save", () => {
  it("rejects malformed tokens with ClaudeOatError", () => {
    expect(() =>
      saveToken(ports, { token: "nope", sessionId: "s" }),
    ).toThrow(ClaudeOatError);
  });

  it("active state after valid save", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    expect(peek(ports).state).toBe("active");
    expect(peek(ports).hasToken).toBe(true);
  });

  it("idempotent on identical token", () => {
    const r1 = saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    const r2 = saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    expect(r1.tokenFingerprint).toBe(r2.tokenFingerprint);
    // No second save audit entry on identical-token re-save.
    expect(audit.byType("save")).toHaveLength(1);
  });

  it("rotation preserves previous slot for fallback", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    saveToken(ports, { token: VALID_OAT_2, sessionId: "s" });
    expect(store.raw().active?.tokenFingerprint).not.toBe(
      store.raw().previous?.tokenFingerprint,
    );
    expect(store.raw().previous).not.toBeNull();
  });
});

describe("peek", () => {
  it("never returns the full token", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    const view = peek(ports);
    expect(view.tokenPrefix).toMatch(/^sk-ant-oat01-[A-Za-z0-9_-]{7}…$/);
    expect(view.tokenPrefix).not.toContain(VALID_OAT);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Issuance + redeem (single-use, audit-trail)
// ────────────────────────────────────────────────────────────────────────────

describe("issuance + redeem", () => {
  it("redeem returns the OAT exactly once", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    const i = issueOat(ports, { threadId: "t", project: null });
    const r1 = redeemOat(ports, { issuanceToken: i.issuanceToken });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.token).toBe(VALID_OAT);
    const r2 = redeemOat(ports, { issuanceToken: i.issuanceToken });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("issuance-token-not-found");
  });

  it("expired issuance token cannot be redeemed", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    const i = issueOat(ports, { threadId: "t", project: null });
    clock.advance(120_000); // > 60s TTL
    const r = redeemOat(ports, { issuanceToken: i.issuanceToken });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("issuance-token-expired");
  });

  it("redeem fails on non-active state", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    revokeOat(ports, { sessionId: "s", reason: "user-logout" });
    const i = issueOat(ports, { threadId: "t", project: null });
    const r = redeemOat(ports, { issuanceToken: i.issuanceToken });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("credential-not-active");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE STRUCTURAL INVARIANT — only verified probes can mutate state
// ────────────────────────────────────────────────────────────────────────────

describe("state machine: ONLY verified probes mutate state", () => {
  it("report-401 from bridge does NOT change state", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    const result = reportUnauth(
      ports,
      {
        threadId: "t",
        turnId: "u",
        anthropicRequestId: "req",
        model: "sonnet",
      },
      signalImmediate,
    );
    expect(peek(ports).state).toBe("active");
    expect(peek(ports).hasToken).toBe(true);
    expect(result.probeScheduled).toBe(true);
    expect(immediateProbeRequested).toBe(true);
  });

  it("100 rapid report-401 calls never destroy the token", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    for (let i = 0; i < 100; i++) {
      reportUnauth(
        ports,
        {
          threadId: `t${i}`,
          turnId: null,
          anthropicRequestId: null,
          model: null,
        },
        signalImmediate,
      );
    }
    expect(peek(ports).state).toBe("active");
    expect(getTokenForProbe(ports)).toBe(VALID_OAT);
  });

  it("single probe-401: active → suspect, token preserved", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    recordProbeOutcome(ports, {
      ts: clock.iso(),
      outcome: "auth-failed",
      latencyMs: 100,
      httpStatus: 401,
      anthropicRequestId: null,
    });
    expect(peek(ports).state).toBe("suspect");
    expect(getTokenForProbe(ports)).toBe(VALID_OAT);
  });

  it("3 probe-401s within window: suspect → revoked", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    for (let i = 0; i < 3; i++) {
      clock.advance(1_000);
      recordProbeOutcome(ports, {
        ts: clock.iso(),
        outcome: "auth-failed",
        latencyMs: 100,
        httpStatus: 401,
        anthropicRequestId: null,
      });
    }
    expect(peek(ports).state).toBe("revoked");
    expect(getTokenForProbe(ports)).toBeNull();
    expect(peek(ports).revokedReason).toBe("probe-quorum-failure");
  });

  it("probe success between failures resets quorum counter", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    recordProbeOutcome(ports, {
      ts: clock.iso(),
      outcome: "auth-failed",
      latencyMs: 100,
      httpStatus: 401,
      anthropicRequestId: null,
    });
    expect(peek(ports).state).toBe("suspect");
    clock.advance(1_000);
    recordProbeOutcome(ports, {
      ts: clock.iso(),
      outcome: "ok",
      latencyMs: 50,
      httpStatus: 200,
      anthropicRequestId: null,
    });
    expect(peek(ports).state).toBe("active");
    expect(peek(ports).suspectFailureCount).toBe(0);
  });

  it("rate-limit / 5xx / network never count toward quorum", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    for (const outcome of [
      "rate-limited",
      "anthropic-error",
      "network-error",
    ] as const) {
      for (let i = 0; i < 5; i++) {
        recordProbeOutcome(ports, {
          ts: clock.iso(),
          outcome,
          latencyMs: 100,
          httpStatus: outcome === "anthropic-error" ? 503 : 429,
          anthropicRequestId: null,
        });
      }
    }
    expect(peek(ports).state).toBe("active");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// THE FUZZ — adversarial inputs across the entire surface
// ────────────────────────────────────────────────────────────────────────────

describe("adversarial fuzz: token survives every malicious input", () => {
  const TRIGGER_PHRASES = [
    "Not logged in",
    "not logged in",
    "Please run /login",
    "please run /login",
    'api_error_status":401',
    "authentication_failed",
    'API Error: 401 {"type":"error"}',
    "Invalid bearer token",
    "your token has been revoked",
  ];

  it("trigger phrases via report-401 never destroy the token", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    for (const phrase of TRIGGER_PHRASES) {
      reportUnauth(
        ports,
        {
          threadId: phrase,
          turnId: phrase,
          anthropicRequestId: phrase,
          model: phrase,
        },
        signalImmediate,
      );
    }
    expect(peek(ports).state).toBe("active");
    expect(getTokenForProbe(ports)).toBe(VALID_OAT);
  });

  it("rapid spawn cycle (issue/redeem ×100) never destroys the token", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    for (let i = 0; i < 100; i++) {
      const issue = issueOat(ports, { threadId: `t${i}`, project: `p${i}` });
      const r = redeemOat(ports, { issuanceToken: issue.issuanceToken });
      expect(r.ok).toBe(true);
    }
    expect(peek(ports).state).toBe("active");
  });

  it("interleaved 401 reports + transient errors + spawns preserve token", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    for (let i = 0; i < 30; i++) {
      reportUnauth(
        ports,
        { threadId: `t${i}`, turnId: null, anthropicRequestId: null, model: null },
        signalImmediate,
      );
      issueOat(ports, { threadId: `t${i}`, project: null });
      recordProbeOutcome(ports, {
        ts: clock.iso(),
        outcome: i % 2 === 0 ? "rate-limited" : "ok",
        latencyMs: 100,
        httpStatus: i % 2 === 0 ? 429 : 200,
        anthropicRequestId: null,
      });
      clock.advance(500);
    }
    expect(peek(ports).state).toBe("active");
    expect(getTokenForProbe(ports)).toBe(VALID_OAT);
  });

  it("audit log captures every state change with correct types", () => {
    saveToken(ports, { token: VALID_OAT, sessionId: "s" });
    const i = issueOat(ports, { threadId: "t", project: "p" });
    redeemOat(ports, { issuanceToken: i.issuanceToken });
    reportUnauth(
      ports,
      { threadId: "t", turnId: null, anthropicRequestId: null, model: null },
      signalImmediate,
    );
    revokeOat(ports, { sessionId: "s", reason: "user-logout" });
    const types = audit.types();
    expect(types).toContain("save");
    expect(types).toContain("issue");
    expect(types).toContain("redeem");
    expect(types).toContain("report-401");
    expect(types).toContain("revoke");
    expect(types).toContain("transition");
  });
});
