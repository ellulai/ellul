// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Domain-layer unit tests for state-transitions.
 *
 * These are PURE — no I/O, no clocks (timestamps are inputs), no
 * infrastructure. The point: verify that the only way to move state to
 * suspect/revoked from auth-failure is via applyProbeOutcome with
 * outcome="auth-failed". Bridge's report-401 path (applyReportUnauth)
 * MUST NOT touch state.
 */

import { describe, expect, it } from "vitest";
import type { ProbeRecord } from "@vps/shared/claude-oat";
import {
  applyProbeOutcome,
  applyReportUnauth,
  applyRevoke,
  applySave,
  applyTamperRevoke,
} from "../domain/state-transitions";
import { emptyStore } from "../domain/store";
import type { WrappedCredential } from "../domain/credential";

const fakeCred = (fingerprint: string, ts = "2026-04-26T18:00:00Z"): WrappedCredential => ({
  wrappedToken: "ct",
  nonce: "iv",
  authTag: "tag",
  tokenFingerprint: fingerprint,
  createdAt: ts,
  lastVerifiedAt: null,
});

const probe = (overrides: Partial<ProbeRecord> = {}): ProbeRecord => ({
  ts: "2026-04-26T18:00:00Z",
  outcome: "ok",
  latencyMs: 100,
  httpStatus: 200,
  anthropicRequestId: null,
  ...overrides,
});

describe("applySave", () => {
  it("transitions empty → active", () => {
    const next = applySave(emptyStore(), fakeCred("fp1"));
    expect(next.state).toBe("active");
    expect(next.active?.tokenFingerprint).toBe("fp1");
    expect(next.previous).toBeNull();
  });

  it("preserves previous active credential as fallback on rotation", () => {
    const s1 = applySave(emptyStore(), fakeCred("fp1"));
    const s2 = applySave(s1, fakeCred("fp2"));
    expect(s2.active?.tokenFingerprint).toBe("fp2");
    expect(s2.previous?.tokenFingerprint).toBe("fp1");
  });

  it("clears suspectFailures and revoke metadata", () => {
    const revoked = applyRevoke(
      applySave(emptyStore(), fakeCred("fp1")),
      "user-logout",
      "2026-04-26T18:00:00Z",
    );
    const next = applySave(revoked, fakeCred("fp2"));
    expect(next.state).toBe("active");
    expect(next.revokedAt).toBeNull();
    expect(next.revokedReason).toBeNull();
    expect(next.suspectFailures).toEqual([]);
  });
});

describe("applyReportUnauth — AUDIT-ONLY, never mutates state", () => {
  it("does not change state", () => {
    const active = applySave(emptyStore(), fakeCred("fp1"));
    const next = applyReportUnauth(active);
    expect(next.state).toBe("active");
    expect(next.active?.tokenFingerprint).toBe("fp1");
  });

  it("100 calls in a row preserve token", () => {
    let s = applySave(emptyStore(), fakeCred("fp1"));
    for (let i = 0; i < 100; i++) {
      s = applyReportUnauth(s);
    }
    expect(s.state).toBe("active");
    expect(s.active?.tokenFingerprint).toBe("fp1");
  });

  it("only mutation is the audit counter", () => {
    const before = applySave(emptyStore(), fakeCred("fp1"));
    const after = applyReportUnauth(before);
    expect(after.bridgeReportedUnauthCount).toBe(
      before.bridgeReportedUnauthCount + 1,
    );
  });
});

describe("applyProbeOutcome — the only state-mutation path for auth failures", () => {
  const NOW = Date.parse("2026-04-26T18:00:00Z");

  it("ok outcome on active: stays active, lastVerifiedAt updated", () => {
    const active = applySave(emptyStore(), fakeCred("fp1"));
    const result = applyProbeOutcome(
      active,
      probe({ outcome: "ok", ts: "2026-04-26T18:01:00Z" }),
      NOW,
    );
    expect(result.next.state).toBe("active");
    expect(result.next.active?.lastVerifiedAt).toBe("2026-04-26T18:01:00Z");
    expect(result.transitioned).toBe(false);
  });

  it("ok outcome on suspect: recovers to active", () => {
    let s = applySave(emptyStore(), fakeCred("fp1"));
    s = applyProbeOutcome(
      s,
      probe({ outcome: "auth-failed", httpStatus: 401, ts: "2026-04-26T18:00:01Z" }),
      NOW,
    ).next;
    expect(s.state).toBe("suspect");
    const r = applyProbeOutcome(
      s,
      probe({ outcome: "ok", ts: "2026-04-26T18:00:02Z" }),
      NOW + 1000,
    );
    expect(r.next.state).toBe("active");
    expect(r.recovered).toBe(true);
    expect(r.next.suspectFailures).toEqual([]);
  });

  it("auth-failed: 1 fail = suspect, 3 fails in window = revoked", () => {
    let s = applySave(emptyStore(), fakeCred("fp1"));
    s = applyProbeOutcome(
      s,
      probe({ outcome: "auth-failed", httpStatus: 401, ts: "2026-04-26T18:00:00Z" }),
      NOW,
    ).next;
    expect(s.state).toBe("suspect");
    s = applyProbeOutcome(
      s,
      probe({ outcome: "auth-failed", httpStatus: 401, ts: "2026-04-26T18:00:30Z" }),
      NOW + 30_000,
    ).next;
    expect(s.state).toBe("suspect");
    const r = applyProbeOutcome(
      s,
      probe({ outcome: "auth-failed", httpStatus: 401, ts: "2026-04-26T18:01:00Z" }),
      NOW + 60_000,
    );
    expect(r.next.state).toBe("revoked");
    expect(r.next.revokedReason).toBe("probe-quorum-failure");
    expect(r.next.active).toBeNull();
  });

  it("rate-limit / 5xx / network-error never moves state", () => {
    let s = applySave(emptyStore(), fakeCred("fp1"));
    for (const outcome of [
      "rate-limited",
      "anthropic-error",
      "network-error",
      "rate-limited",
      "anthropic-error",
      "network-error",
    ] as const) {
      s = applyProbeOutcome(
        s,
        probe({ outcome, httpStatus: outcome === "anthropic-error" ? 503 : 429 }),
        NOW,
      ).next;
    }
    expect(s.state).toBe("active");
    expect(s.active?.tokenFingerprint).toBe("fp1");
  });

  it("trims verifyHistory to 10 entries", () => {
    let s = applySave(emptyStore(), fakeCred("fp1"));
    for (let i = 0; i < 15; i++) {
      s = applyProbeOutcome(
        s,
        probe({ outcome: "ok", ts: `2026-04-26T18:${String(i).padStart(2, "0")}:00Z` }),
        NOW + i * 1000,
      ).next;
    }
    expect(s.verifyHistory.length).toBe(10);
  });
});

describe("applyRevoke", () => {
  it("user-logout transitions to revoked, clears tokens", () => {
    const active = applySave(emptyStore(), fakeCred("fp1"));
    const revoked = applyRevoke(active, "user-logout", "2026-04-26T18:00:00Z");
    expect(revoked.state).toBe("revoked");
    expect(revoked.active).toBeNull();
    expect(revoked.previous).toBeNull();
    expect(revoked.revokedReason).toBe("user-logout");
  });

  it("idempotent on already-revoked", () => {
    const active = applySave(emptyStore(), fakeCred("fp1"));
    const r1 = applyRevoke(active, "user-logout", "2026-04-26T18:00:00Z");
    const r2 = applyRevoke(r1, "user-logout", "2026-04-26T18:01:00Z");
    expect(r2).toBe(r1); // referential equality — no churn
  });
});

describe("applyTamperRevoke", () => {
  it("forces revoked with reason='tamper-detected'", () => {
    const active = applySave(emptyStore(), fakeCred("fp1"));
    const r = applyTamperRevoke(active, "2026-04-26T18:00:00Z");
    expect(r.state).toBe("revoked");
    expect(r.revokedReason).toBe("tamper-detected");
    expect(r.active).toBeNull();
  });
});
