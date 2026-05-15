// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { signIn } from "@/lib/auth-client";
import { isTauriApp } from "@/lib/utils";
import { isLoginProviderEnabled } from "@/lib/feature-flags";

type Provider = "github" | "google" | "apple";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

function tauriInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  return (window as any).__TAURI_INTERNALS__.invoke(cmd, args);
}

function GitHubIcon() {
  return (
    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}

export type OAuthSignInProps = {
  /** Persisted to sessionStorage as `ps_signup_product_plan` after OAuth. */
  productPlan?: string | null;
  /** CLI callback port — persisted to localStorage to survive Stripe bounces. */
  callbackPort?: string | null;
  /** CLI callback nonce — paired with port. */
  callbackNonce?: string | null;
  /** Where to land after successful auth. Defaults to /dashboard. */
  callbackPath?: string;
};

export function OAuthSignIn({
  productPlan,
  callbackPort,
  callbackNonce,
  callbackPath = "/dashboard",
}: OAuthSignInProps) {
  const router = useRouter();
  const tAuth = useTranslations("auth");
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAppleDevice, setIsAppleDevice] = useState(false);

  useEffect(() => {
    setIsAppleDevice(/Mac|iPhone|iPad|iPod/.test(navigator.userAgent));
  }, []);

  const handleSignIn = async (provider: Provider) => {
    setIsSigningIn(true);
    setError(null);

    if (productPlan) {
      sessionStorage.setItem("ps_signup_product_plan", productPlan);
    }
    if (callbackPort && callbackNonce) {
      localStorage.setItem("ps_cli_callback_port", callbackPort);
      localStorage.setItem("ps_cli_callback_nonce", callbackNonce);
    }

    if (isTauriApp()) {
      try {
        if (provider === "apple") {
          const result = (await tauriInvoke("plugin:native-auth|sign_in_apple")) as {
            identity_token: string;
            given_name: string | null;
            family_name: string | null;
          };

          const res = await fetch(`${API_URL}/api/auth/native/apple`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              identityToken: result.identity_token,
              fullName: {
                givenName: result.given_name,
                familyName: result.family_name,
              },
            }),
          });
          if (!res.ok) throw new Error("Apple token exchange failed");
          const { code } = await res.json();

          const sessionRes = await fetch(`${API_URL}/api/auth/native/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ code }),
          });

          if (sessionRes.ok) {
            router.replace(callbackPath);
            return;
          }
        } else {
          const flowId = crypto.randomUUID();
          const oauthUrl = `${API_URL}/api/auth/native/start?provider=${provider}&flow_id=${flowId}`;

          await tauriInvoke("plugin:native-auth|open_oauth_browser", { url: oauthUrl });

          const POLL_MS = 3_000;
          const TIMEOUT_MS = 300_000;
          const start = Date.now();
          let exchangeCode: string | null = null;

          while (Date.now() - start < TIMEOUT_MS) {
            await new Promise((r) => setTimeout(r, POLL_MS));
            try {
              const res = await fetch(`${API_URL}/api/auth/native/poll?flow_id=${flowId}`);
              if (res.ok) {
                const data = await res.json();
                if (data.status === "complete" && data.code) {
                  exchangeCode = data.code;
                  break;
                }
              }
            } catch { /* network hiccup, retry */ }
          }

          if (!exchangeCode) {
            setError("Sign in timed out. Please try again.");
            setIsSigningIn(false);
            return;
          }

          const redirect = `${window.location.origin}${callbackPath}`;
          window.location.href = `${API_URL}/api/auth/native/session/establish?code=${encodeURIComponent(exchangeCode)}&redirect=${encodeURIComponent(redirect)}`;
          return;
        }
      } catch (err) {
        console.error("Native auth failed:", err);
        setError("Sign in failed. Please try again.");
        setIsSigningIn(false);
        return;
      }
    }

    try {
      const { error: authError } = await signIn.social({
        provider,
        callbackURL: `${window.location.origin}${callbackPath}`,
      });
      if (authError) {
        console.error("Social sign-in error:", authError);
        setError(authError.message || "Sign in failed. Please try again.");
        setIsSigningIn(false);
      }
    } catch (err) {
      console.error("Social sign-in failed:", err);
      setError("Unable to connect. Please try again.");
      setIsSigningIn(false);
    }
  };

  const baseBtn =
    "w-full flex items-center justify-center gap-3 rounded-xl border border-[rgba(245,239,230,0.07)] bg-[#13131A] px-6 py-3.5 text-sm font-semibold text-cream transition-all hover:bg-[#1A1A23] hover:border-[rgba(245,239,230,0.14)] disabled:opacity-50";

  return (
    <div className="space-y-3">
      {error && (
        <p className="text-center text-sm text-red-400">{error}</p>
      )}
      {isLoginProviderEnabled("github") && (
        <button onClick={() => handleSignIn("github")} disabled={isSigningIn} className={baseBtn}>
          <GitHubIcon />
          {tAuth("continueWith.github")}
        </button>
      )}
      {isLoginProviderEnabled("google") && (
        <button onClick={() => handleSignIn("google")} disabled={isSigningIn} className={baseBtn}>
          <GoogleIcon />
          {tAuth("continueWith.google")}
        </button>
      )}
      {isLoginProviderEnabled("apple") && isAppleDevice && (
        <button onClick={() => handleSignIn("apple")} disabled={isSigningIn} className={baseBtn}>
          <AppleIcon />
          {tAuth("continueWith.apple")}
        </button>
      )}
    </div>
  );
}
