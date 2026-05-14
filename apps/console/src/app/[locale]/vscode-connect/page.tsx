// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { getSession, signIn } from "@/lib/auth-client";
import { LoadingScreen, Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { API_URL } from "@/lib/api";
import { Shield, Monitor, ArrowLeft } from "lucide-react";

interface ServerInfo {
  state: string;
  server: {
    id: string;
    domain: string | null;
    ipAddress: string | null;
    securityTier?: string;
    size?: string;
    tier?: string;
  } | null;
  plan: string;
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

function VscodeConnectContent() {
  const t = useTranslations("console.vscodeConnect");
  const searchParams = useSearchParams();
  const nonce = searchParams.get("nonce");

  const [error, setError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [blockReason, setBlockReason] = useState<
    | null
    | { type: "no_nonce" }
    | { type: "no_server" }
    | { type: "not_active"; status: string }
  >(null);

  useEffect(() => {
    if (!nonce) {
      setBlockReason({ type: "no_nonce" });
      return;
    }

    const init = async () => {
      try {
        const { data } = await getSession();
        if (!data) {
          setNeedsAuth(true);
          return;
        }

        const res = await fetch(`${API_URL}/api/servers/status`, {
          credentials: "include",
        });
        if (!res.ok) throw new Error(t("fetchStatusFailed"));
        const status = (await res.json()) as ServerInfo;

        if (!status.server || status.state === "none") {
          setBlockReason({ type: "no_server" });
          return;
        }

        if (status.state !== "running") {
          setBlockReason({ type: "not_active", status: status.state });
          return;
        }

        if (!status.server.domain) {
          setError(t("noDomainConfigured"));
          return;
        }

        // Auto-redirect back to VS Code with the server domain
        const vscodeUri =
          `vscode://ellul-ai.sovereign-ide/server-resolved` +
          `?domain=${encodeURIComponent(status.server.domain)}` +
          `&nonce=${encodeURIComponent(nonce)}`;
        window.location.href = vscodeUri;
        setTimeout(() => {
          try {
            window.close();
          } catch {}
        }, 500);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t("genericError")
        );
      }
    };
    init();
  }, [nonce, t]);

  const handleSignIn = (provider: "github" | "google") => {
    setIsSigningIn(true);
    const returnUrl = `/vscode-connect${nonce ? `?nonce=${nonce}` : ""}`;
    signIn.social({ provider, callbackURL: returnUrl });
  };

  // ── Sign in required ──
  if (needsAuth) {
    return (
      <Shell>
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 space-y-5">
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full border border-sodium/20 bg-sodium/5 mb-4">
                <Shield className="w-5 h-5 text-sodium" />
              </div>
              <h2 className="text-lg font-semibold text-cream">
                {t("signInTitle")}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                {t("signInSubtitle")}
              </p>
            </div>

            <div className="space-y-2.5">
              <button
                onClick={() => handleSignIn("github")}
                disabled={isSigningIn}
                className="w-full flex items-center justify-center gap-3 rounded-xl border border-cream/[0.08] bg-cream/[0.03] px-6 py-3 text-sm font-medium text-cream transition-all hover:bg-cream/[0.06] hover:border-cream/[0.12] disabled:opacity-50"
              >
                <GitHubIcon />
                {t("continueWithGitHub")}
              </button>
              <button
                onClick={() => handleSignIn("google")}
                disabled={isSigningIn}
                className="w-full flex items-center justify-center gap-3 rounded-xl border border-cream/[0.08] bg-cream/[0.03] px-6 py-3 text-sm font-medium text-cream transition-all hover:bg-cream/[0.06] hover:border-cream/[0.12] disabled:opacity-50"
              >
                <GoogleIcon />
                {t("continueWithGoogle")}
              </button>
            </div>

            <p className="text-[11px] text-center text-cream/35">
              {t("termsAcceptance")}
            </p>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  // ── Error ──
  if (error) {
    return (
      <Shell>
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full border border-terra/20 bg-terra/5">
              <Shield className="w-5 h-5 text-terra" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-cream mb-1">
                {t("connectionFailedTitle")}
              </h2>
              <p className="text-sm text-terra">{error}</p>
            </div>
            <p className="text-xs text-cream/45">
              {t("connectionFailedHint")}
            </p>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  // ── No nonce ──
  if (blockReason?.type === "no_nonce") {
    return (
      <Shell>
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full border border-cream/[0.08] bg-cream/[0.03]">
              <Monitor className="w-5 h-5 text-cream/60" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-cream mb-1">
                {t("noNonceTitle")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("noNonceBodyBefore")}
                <Badge variant="outline" className="mx-1">
                  {t("noNonceBodyBadge")}
                </Badge>
                {t("noNonceBodyAfter")}
              </p>
            </div>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  // ── No server ──
  if (blockReason?.type === "no_server") {
    return (
      <Shell>
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full border border-cream/[0.08] bg-cream/[0.03]">
              <Monitor className="w-5 h-5 text-cream/60" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-cream mb-1">
                {t("noServerTitle")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("noServerBody")}
              </p>
            </div>
            <Button asChild>
              <a href="/dashboard">{t("goToDashboard")}</a>
            </Button>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  // ── Server not active ──
  if (blockReason?.type === "not_active") {
    return (
      <Shell>
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 text-center space-y-4">
            <Spinner size="lg" color="primary" />
            <div>
              <h2 className="text-lg font-semibold text-cream mb-1">
                {t("notReadyTitle")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("notReadyBodyBefore")}
                <Badge variant="warning">{blockReason.status}</Badge>
                {t("notReadyBodyAfter")}
              </p>
            </div>
            <Button variant="outline" asChild>
              <a href="/dashboard">
                <ArrowLeft className="w-4 h-4 mr-1" />
                {t("dashboard")}
              </a>
            </Button>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  // ── Loading / redirecting ──
  return <LoadingScreen message={t("connectingMessage")} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center px-4 gap-6"
      style={{
        background:
          "radial-gradient(ellipse at 20% 0%, rgba(245,239,230,0.4) 0%, transparent 60%), " +
          "radial-gradient(ellipse at 80% 100%, rgba(240,166,90,0.15) 0%, transparent 50%), " +
          "#0B0B0F",
        backgroundAttachment: "fixed",
      }}
    >
      <span className="text-lg font-bold tracking-tight text-cream">
        ellul
      </span>
      {children}
    </main>
  );
}

export default function VscodeConnectPage() {
  const t = useTranslations("console.vscodeConnect");
  return (
    <Suspense fallback={<LoadingScreen message={t("loadingFallback")} />}>
      <VscodeConnectContent />
    </Suspense>
  );
}
