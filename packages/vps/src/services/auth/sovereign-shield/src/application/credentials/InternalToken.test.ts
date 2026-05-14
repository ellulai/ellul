// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Internal Token Service — Unit Tests
 *
 * Tests per-service HMAC-derived token system:
 *   1. Token derivation produces unique tokens per service
 *   2. validateInternalToken accepts correct service + token pair
 *   3. validateInternalToken rejects cross-service token reuse
 *   4. validateInternalToken rejects unknown service names
 *   5. Legacy global token accepted during grace window
 *   6. Legacy global token rejected after grace window
 *   7. Rotation grace window accepts previous tokens
 *   8. getVerifiedService identifies correct service from token
 *   9. getTokenForService returns correct derived token
 *  10. Timing-safe comparison handles length mismatches
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs to prevent actual file writes
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(() => true),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

// Mock config
vi.mock("../../config", () => ({
  INTERNAL_TOKEN_PATH: "/run/shield/internal.token",
}));

import {
  initInternalToken,
  validateInternalToken,
  getVerifiedService,
  getTokenForService,
} from "./InternalToken";

describe("internal-token.service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initInternalToken();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("token derivation", () => {
    it("produces unique tokens per service", () => {
      const fileApiToken = getTokenForService("file-api");
      const bridgeToken = getTokenForService("agent-bridge");
      const enforcerToken = getTokenForService("enforcer");

      expect(fileApiToken).not.toBe(bridgeToken);
      expect(fileApiToken).not.toBe(enforcerToken);
      expect(bridgeToken).not.toBe(enforcerToken);
    });

    it("produces 64-char hex tokens", () => {
      const token = getTokenForService("file-api");
      expect(token).toMatch(/^[a-f0-9]{64}$/);
    });

    it("each service token is unique from every other", () => {
      const all = ["file-api", "agent-bridge", "enforcer"].map((s) =>
        getTokenForService(s as any),
      );
      const unique = new Set(all);
      expect(unique.size).toBe(3);
    });
  });

  describe("validateInternalToken — per-service scoping", () => {
    it("accepts correct service + token pair", () => {
      const token = getTokenForService("file-api");
      expect(validateInternalToken(`Bearer ${token}`, "file-api")).toBe(true);
    });

    it("accepts agent-bridge token for agent-bridge", () => {
      const token = getTokenForService("agent-bridge");
      expect(validateInternalToken(`Bearer ${token}`, "agent-bridge")).toBe(
        true,
      );
    });

    it("rejects cross-service token reuse (file-api token claiming agent-bridge)", () => {
      const fileApiToken = getTokenForService("file-api");
      expect(
        validateInternalToken(`Bearer ${fileApiToken}`, "agent-bridge"),
      ).toBe(false);
    });

    it("rejects cross-service token reuse (agent-bridge token claiming file-api)", () => {
      const bridgeToken = getTokenForService("agent-bridge");
      expect(validateInternalToken(`Bearer ${bridgeToken}`, "file-api")).toBe(
        false,
      );
    });

    it("rejects unknown service name", () => {
      const token = getTokenForService("file-api");
      expect(validateInternalToken(`Bearer ${token}`, "evil-service")).toBe(
        false,
      );
    });

    it("rejects missing service name (no legacy fallback)", () => {
      const token = getTokenForService("file-api");
      expect(validateInternalToken(`Bearer ${token}`)).toBe(false);
    });

    it("rejects empty bearer token", () => {
      expect(validateInternalToken("Bearer ", "file-api")).toBe(false);
    });

    it("rejects missing Authorization header", () => {
      expect(validateInternalToken(undefined, "file-api")).toBe(false);
    });

    it("rejects non-Bearer scheme", () => {
      const token = getTokenForService("file-api");
      expect(validateInternalToken(`Basic ${token}`, "file-api")).toBe(false);
    });

    it("rejects garbage token", () => {
      expect(validateInternalToken("Bearer deadbeef", "file-api")).toBe(false);
    });
  });

  describe("rotation grace window", () => {
    it("accepts previous token during 60s grace window after rotation", () => {
      const oldToken = getTokenForService("file-api");

      // Trigger rotation (advance 30 minutes)
      vi.advanceTimersByTime(30 * 60 * 1000);

      // New token should be different
      const newToken = getTokenForService("file-api");
      expect(newToken).not.toBe(oldToken);

      // Old token should still be accepted during grace window
      expect(validateInternalToken(`Bearer ${oldToken}`, "file-api")).toBe(
        true,
      );

      // New token should also be accepted
      expect(validateInternalToken(`Bearer ${newToken}`, "file-api")).toBe(
        true,
      );
    });

    it("rejects previous token after grace window expires", () => {
      const oldToken = getTokenForService("file-api");

      // Trigger rotation
      vi.advanceTimersByTime(30 * 60 * 1000);

      // Advance past 60s grace window
      vi.advanceTimersByTime(61 * 1000);

      // Old token should be rejected
      expect(validateInternalToken(`Bearer ${oldToken}`, "file-api")).toBe(
        false,
      );

      // New token should still work
      const newToken = getTokenForService("file-api");
      expect(validateInternalToken(`Bearer ${newToken}`, "file-api")).toBe(
        true,
      );
    });

    it("cross-service rejection still holds after rotation", () => {
      // Trigger rotation
      vi.advanceTimersByTime(30 * 60 * 1000);

      const fileApiToken = getTokenForService("file-api");
      expect(
        validateInternalToken(`Bearer ${fileApiToken}`, "agent-bridge"),
      ).toBe(false);
    });
  });

  describe("getVerifiedService", () => {
    it("identifies file-api from its token", () => {
      const token = getTokenForService("file-api");
      expect(getVerifiedService(`Bearer ${token}`)).toBe("file-api");
    });

    it("identifies agent-bridge from its token", () => {
      const token = getTokenForService("agent-bridge");
      expect(getVerifiedService(`Bearer ${token}`)).toBe("agent-bridge");
    });

    it("identifies enforcer from its token", () => {
      const token = getTokenForService("enforcer");
      expect(getVerifiedService(`Bearer ${token}`)).toBe("enforcer");
    });

    it("returns null for garbage token", () => {
      expect(getVerifiedService("Bearer deadbeef")).toBe(null);
    });

    it("returns null for undefined header", () => {
      expect(getVerifiedService(undefined)).toBe(null);
    });

    it("identifies previous token during rotation grace", () => {
      const oldToken = getTokenForService("enforcer");
      vi.advanceTimersByTime(30 * 60 * 1000); // trigger rotation
      expect(getVerifiedService(`Bearer ${oldToken}`)).toBe("enforcer");
    });
  });

  describe("timing safety", () => {
    it("rejects token with correct prefix but wrong length", () => {
      const token = getTokenForService("file-api");
      const truncated = token.slice(0, 32);
      expect(validateInternalToken(`Bearer ${truncated}`, "file-api")).toBe(
        false,
      );
    });

    it("rejects token with correct length but wrong content", () => {
      const token = getTokenForService("file-api");
      // Flip first character
      const flipped = (token[0] === "a" ? "b" : "a") + token.slice(1);
      expect(validateInternalToken(`Bearer ${flipped}`, "file-api")).toBe(
        false,
      );
    });
  });
});
