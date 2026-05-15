// SPDX-License-Identifier: MIT
"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/types";
import { isElectronApp } from "@/lib/utils";

// ── State machine ────────────────────────────────────────────────
//
//   initializing ─┬─ has session ──→ authenticated
//                 └─ no session ───→ unauthenticated ──→ authenticating ─┬─→ authenticated
//                                        ↑                              └─→ error ──→ (retry) authenticating
//   authenticated ──(expired/signal)──→ unauthenticated ──→ ...
//

export type ShieldAuthPhase =
  | "initializing"
  | "unauthenticated"
  | "authenticating"
  | "authenticated"
  | "error";

export type NativeInvokeFn = <T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export interface NativeShieldAuth {
  phase: ShieldAuthPhase;
  error: string | null;

  ready: boolean;
  needsVpsAuth: boolean;
  sessionExpired: boolean;

  authenticate: () => Promise<void>;
  register: (name: string) => Promise<unknown>;
  signalAuthNeeded: () => void;
  reload: () => void;
}

const MAX_AUTO_RETRIES = 3;
const RETRY_BASE_MS = 2_000;
const KEEPALIVE_PREEMPT_MS = 5 * 60 * 1000;
const KEEPALIVE_FLOOR_MS = 10_000;

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.ellul.ai";
const RELAY_POLL_MS = 1_500;
const RELAY_TIMEOUT_MS = 120_000;

async function relayPasskeyViaBrowser(
  options: PublicKeyCredentialRequestOptionsJSON,
  hostname: string,
): Promise<unknown> {
  const flowId = crypto.randomUUID();

  await fetch(`${API_URL}/api/auth/native/vps-auth-data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flowId, type: "options", data: options }),
  });

  const passkeyUrl = `${window.location.origin}/auth/vps-passkey?flow_id=${encodeURIComponent(flowId)}`;
  window.open(passkeyUrl, "_blank");

  const deadline = Date.now() + RELAY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RELAY_POLL_MS));
    const res = await fetch(
      `${API_URL}/api/auth/native/vps-auth-data?flow_id=${encodeURIComponent(flowId)}&type=assertion`,
    );
    const body = await res.json() as { status: string; data?: unknown };
    if (body.status === "complete" && body.data) return body.data;
  }
  throw new Error("Passkey authentication timed out. Please try again.");
}

export function useNativeShieldAuth(
  hostname: string,
  invoke: NativeInvokeFn,
): NativeShieldAuth {
  const [phase, setPhase] = useState<ShieldAuthPhase>("initializing");
  const [error, setError] = useState<string | null>(null);
  const [wasAuthenticated, setWasAuthenticated] = useState(false);

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const autoRetryCount = useRef(0);
  const authInFlight = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const set = useCallback((p: ShieldAuthPhase, err?: string) => {
    if (!mountedRef.current) return;
    setPhase(p);
    setError(err ?? null);
    if (p === "authenticated") setWasAuthenticated(true);
  }, []);

  // ── Passkey login ceremony ─────────────────────────────────────

  const authenticate = useCallback(async (): Promise<void> => {
    if (authInFlight.current) return;
    authInFlight.current = true;
    set("authenticating");

    try {
      const options = await invoke<PublicKeyCredentialRequestOptionsJSON>(
        "shield_login_options",
        { serverDomain: hostname },
      );

      let assertion: unknown;
      const hasPlatform =
        typeof PublicKeyCredential !== "undefined" &&
        (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());

      if (hasPlatform) {
        assertion = await startAuthentication({ optionsJSON: options });
      } else if (isElectronApp()) {
        assertion = await relayPasskeyViaBrowser(options, hostname);
      } else {
        assertion = await startAuthentication({ optionsJSON: options });
      }

      await invoke("shield_login_verify", { serverDomain: hostname, assertion });
      autoRetryCount.current = 0;
      set("authenticated");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set("error", msg);
    } finally {
      authInFlight.current = false;
    }
  }, [hostname, invoke, set]);

  // ── Passkey registration ceremony ──────────────────────────────

  const register = useCallback(async (name: string): Promise<unknown> => {
    const regOptions = await invoke<{
      options: PublicKeyCredentialCreationOptionsJSON;
    }>("shield_register_options", { serverDomain: hostname, body: { name } });

    const optionsJSON =
      regOptions.options ??
      (regOptions as unknown as PublicKeyCredentialCreationOptionsJSON);

    const attestation = await startRegistration({ optionsJSON });
    const extResults = attestation.clientExtensionResults as
      | Record<string, unknown>
      | undefined;
    const prfEnabled =
      (extResults?.prf as { enabled?: boolean } | undefined)?.enabled === true;

    return invoke("shield_register_verify", {
      serverDomain: hostname,
      body: { attestation, name, prfEnabled },
    });
  }, [hostname, invoke]);

  // ── External auth signal ───────────────────────────────────────

  const signalAuthNeeded = useCallback(() => {
    if (phaseRef.current === "authenticating") return;
    autoRetryCount.current = 0;
    set("unauthenticated");
  }, [set]);

  // ── Full session reload ────────────────────────────────────────

  const reload = useCallback(() => {
    autoRetryCount.current = 0;
    set("initializing");
    invoke("shield_clear_session")
      .catch(() => {})
      .finally(() => {
        invoke<{ hasSession: boolean }>("shield_check_session")
          .then((res) => set(res.hasSession ? "authenticated" : "unauthenticated"))
          .catch(() => set("unauthenticated"));
      });
  }, [invoke, set]);

  // ── Initial session check ──────────────────────────────────────

  useEffect(() => {
    set("initializing");
    invoke<{ hasSession: boolean }>("shield_check_session")
      .then((res) => set(res.hasSession ? "authenticated" : "unauthenticated"))
      .catch(() => set("unauthenticated"));
  }, [hostname, invoke, set]);

  // ── Auto-authenticate when unauthenticated ─────────────────────

  useEffect(() => {
    if (phase !== "unauthenticated" || !hostname) return;
    authenticate();
  }, [phase, hostname, authenticate]);

  // ── Retry on error with backoff ────────────────────────────────

  useEffect(() => {
    if (phase !== "error") return;
    if (autoRetryCount.current >= MAX_AUTO_RETRIES) return;

    const delay =
      RETRY_BASE_MS * Math.pow(2, autoRetryCount.current) *
      (0.5 + Math.random() * 0.5);
    autoRetryCount.current += 1;

    const timer = setTimeout(() => {
      if (mountedRef.current && phaseRef.current === "error") {
        set("unauthenticated");
      }
    }, delay);

    return () => clearTimeout(timer);
  }, [phase, set]);

  // ── Keepalive scheduling ───────────────────────────────────────

  useEffect(() => {
    if (phase !== "authenticated") return;
    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      invoke<{ active: boolean; expiresAt?: number }>("shield_session_info")
        .then((info) => {
          if (!info.active || !info.expiresAt) return;
          const refreshIn = Math.max(
            info.expiresAt * 1000 - Date.now() - KEEPALIVE_PREEMPT_MS,
            KEEPALIVE_FLOOR_MS,
          );
          timer = setTimeout(() => {
            invoke<{ alive: boolean }>("shield_session_keepalive")
              .then((res) => {
                if (!res.alive) set("unauthenticated");
                else schedule();
              })
              .catch(() => set("unauthenticated"));
          }, refreshIn);
        })
        .catch(() => {});
    };

    schedule();
    return () => clearTimeout(timer);
  }, [phase, invoke, set]);

  // ── Visibility-based session recheck ───────────────────────────

  useEffect(() => {
    if (phase !== "authenticated") return;
    const handler = () => {
      if (document.visibilityState !== "visible") return;
      invoke<{ hasSession: boolean }>("shield_check_session").then((res) => {
        if (!res.hasSession) set("unauthenticated");
      });
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [phase, invoke, set]);

  // ── Electron session-expired + biometric events ────────────────

  useEffect(() => {
    if (!isElectronApp()) return;
    const shield = (window as any).electronShield;
    if (!shield) return;

    const cleanups: Array<() => void> = [];

    if (shield.onSessionExpired) {
      cleanups.push(shield.onSessionExpired(() => {
        if (phaseRef.current === "authenticated") set("unauthenticated");
      }));
    }

    if (shield.onBiometricLocked) {
      cleanups.push(shield.onBiometricLocked(() => {
        if (phaseRef.current === "authenticated") set("unauthenticated");
      }));
    }

    return () => cleanups.forEach((fn) => fn());
  }, [set]);

  // ── Derived state for backwards compatibility ──────────────────

  const ready = phase !== "initializing";
  const needsVpsAuth =
    phase === "unauthenticated" ||
    phase === "authenticating" ||
    phase === "error";
  const sessionExpired = needsVpsAuth && wasAuthenticated;

  return {
    phase,
    error,
    ready,
    needsVpsAuth,
    sessionExpired,
    authenticate,
    register,
    signalAuthNeeded,
    reload,
  };
}
