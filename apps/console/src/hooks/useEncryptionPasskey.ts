// SPDX-License-Identifier: MIT
"use client";

// (FaceID/TouchID) — it never touches the database.

import { useState, useCallback } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  startRegistration,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import { API_URL } from "@/lib/api";
import { derivePrfKey } from "@/lib/passy-prf";

// ─── Types ───────────────────────────────────────────────

interface EncryptionCredential {
  id: string;
  name: string | null;
  prfSupported: boolean;
  createdAt: string;
}

interface CredentialsResponse {
  hasPasskey: boolean;
  prfSupported: boolean;
  credentials: EncryptionCredential[];
}

interface RegisterResult {
  verified: boolean;
  prfSupported: boolean;
  credentialId: string;
}

interface InitVolumeResult {
  success: boolean;
  recoveryKey: string;
}

interface UnlockVolumeResult {
  success: boolean;
  alreadyMounted?: boolean;
  exchangeCode?: string;
}

// ─── API Helpers ─────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}/api/servers${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Hook ────────────────────────────────────────────────

export function useEncryptionPasskey() {
  const queryClient = useQueryClient();
  const [isRegistering, setIsRegistering] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // Query: check if user has encryption passkey
  const {
    data: credentialsData,
    isLoading: isLoadingCredentials,
  } = useQuery<CredentialsResponse>({
    queryKey: ["encryption-credentials"],
    queryFn: () => apiFetch("/encryption/credentials"),
    staleTime: 60_000,
  });

  const hasPasskey = credentialsData?.hasPasskey ?? false;
  const prfSupported = credentialsData?.prfSupported ?? false;
  const credentials = credentialsData?.credentials ?? [];
  const webauthnSupported = typeof window !== "undefined" && browserSupportsWebAuthn();

  // ─── Register Passkey ────────────────────────────────

  const registerPasskey = useCallback(
    async (name?: string): Promise<RegisterResult> => {
      setIsRegistering(true);
      try {
        // 1. Get registration options from API.
        const options = await apiFetch<Record<string, unknown>>(
          "/encryption/register/options",
          { method: "POST" },
        );

        // 2. Start WebAuthn registration ceremony (triggers biometric prompt)
        const regResponse = await startRegistration({
          optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]["optionsJSON"],
        });

        // 3. Verify with API
        const result = await apiFetch<RegisterResult>(
          "/encryption/register/verify",
          {
            method: "POST",
            body: JSON.stringify({ response: regResponse, name }),
          },
        );

        // 4. Invalidate credentials cache
        queryClient.invalidateQueries({ queryKey: ["encryption-credentials"] });

        return result;
      } finally {
        setIsRegistering(false);
      }
    },
    [queryClient],
  );

  // ─── Get PRF Key (One-Tap Derive) ───────────────────

  const getPrfKey = useCallback(async (): Promise<string> => {
    setIsAuthenticating(true);
    try {
      const bytes = await derivePrfKey("ellul-luks-vault-v1");
      return btoa(String.fromCharCode(...bytes));
    } finally {
      setIsAuthenticating(false);
    }
  }, []);

  // ─── Init Encrypted Volume ──────────────────────────

  const initVolumeMutation = useMutation<
    InitVolumeResult,
    Error,
    { serverId: string; prfKey: string }
  >({
    mutationFn: async ({ serverId, prfKey }) => {
      return apiFetch<InitVolumeResult>(`/${serverId}/init-encrypted-volume`, {
        method: "POST",
        body: JSON.stringify({ prfKey }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
    },
  });

  // ─── Unlock Volume ──────────────────────────────────
  // queue (ML-KEM encrypted). The API sees the key in transit but never stores

  const unlockVolumeMutation = useMutation<
    UnlockVolumeResult,
    Error,
    { serverId: string; prfKey: string }
  >({
    mutationFn: async ({ serverId, prfKey }) => {
      return apiFetch<UnlockVolumeResult>(`/${serverId}/unlock-volume`, {
        method: "POST",
        body: JSON.stringify({ prfKey }),
      });
    },
    onSuccess: (data) => {
      // Store exchange code for auto-login after server reaches running
      if (data.exchangeCode) {
        sessionStorage.setItem("sovereign-exchange-code", data.exchangeCode);
      }
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
    },
  });

  // ─── Sync Credential from VPS Registration ──────────
  // Primary path: frontend calls this after VPS passkey registration

  const syncCredentialMutation = useMutation<
    { synced: boolean; prfSupported: boolean },
    Error,
    {
      credentialId: string;
      publicKey: string;
      counter: number;
      transports: string[];
      aaguid: string | null;
      prfSupported: boolean;
      name: string;
    }
  >({
    mutationFn: async (params) =>
      apiFetch<{ synced: boolean; prfSupported: boolean }>(
        "/encryption/credentials/sync",
        {
          method: "POST",
          body: JSON.stringify(params),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["encryption-credentials"] });
    },
  });

  // ─── Delete Credential ──────────────────────────────

  const deleteCredentialMutation = useMutation<
    { success: boolean },
    Error,
    string
  >({
    mutationFn: async (credId: string) => {
      return apiFetch<{ success: boolean }>(`/encryption/credentials/${credId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["encryption-credentials"] });
    },
  });

  return {
    // State
    webauthnSupported,
    hasPasskey,
    prfSupported,
    credentials,
    isLoadingCredentials,
    isRegistering,
    isAuthenticating,

    // Actions
    registerPasskey,
    syncCredential: syncCredentialMutation.mutateAsync,
    getPrfKey,
    initVolume: initVolumeMutation.mutateAsync,
    unlockVolume: unlockVolumeMutation.mutateAsync,
    deleteCredential: deleteCredentialMutation.mutateAsync,

    // Mutation states
    isInitializing: initVolumeMutation.isPending,
    isUnlocking: unlockVolumeMutation.isPending,
    initError: initVolumeMutation.error,
    unlockError: unlockVolumeMutation.error,
  };
}
