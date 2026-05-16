// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useState, Suspense } from "react";
import { useTranslations } from "next-intl";
import { getSession, signIn } from "@/lib/auth-client";
import { LoadingScreen, Spinner } from "@/components/ui/spinner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { API_URL } from "@/lib/api";
import { OAuthSignIn } from "@/components/auth/oauth-buttons";
import { CheckCircle2, Cloud, ArrowLeft, Laptop } from "lucide-react";

interface ServerInfo {
  state: string;
  server: {
    id: string;
    domain: string | null;
    ipAddress: string | null;
  } | null;
  plan: string;
}

function ConnectContent() {
  const t = useTranslations("console.appConnect");
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [blockReason, setBlockReason] = useState<
    | null
    | { type: "no_server" }
    | { type: "not_active"; status: string }
  >(null);
  const [connected, setConnected] = useState<{ domain: string } | null>(null);

  useEffect(() => {
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

        setConnected({ domain: status.server.domain });

        setTimeout(() => {
          window.location.href = `ellul://connected?domain=${encodeURIComponent(status.server!.domain!)}`;
        }, 1500);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("genericError"));
      }
    };
    init();
  }, [t]);

  if (needsAuth) {
    return (
      <Shell>
        <Card className="w-full max-w-sm border-cream/[0.06] bg-[#13131A]/80 backdrop-blur">
          <CardContent className="pt-6 space-y-5">
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full border border-sodium/20 bg-sodium/5 mb-4">
                <Cloud className="w-5 h-5 text-sodium" />
              </div>
              <h2 className="text-lg font-semibold text-cream">
                {t("signInTitle")}
              </h2>
              <p className="text-sm text-cream/50 mt-1">
                {t("signInSubtitle")}
              </p>
            </div>

            <OAuthSignIn callbackPath="/connect" />
          </CardContent>
        </Card>
      </Shell>
    );
  }

  if (connected) {
    return (
      <Shell>
        <Card className="w-full max-w-sm border-cream/[0.06] bg-[#13131A]/80 backdrop-blur">
          <CardContent className="pt-6 text-center space-y-5">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full border border-emerald-500/20 bg-emerald-500/5">
              <CheckCircle2 className="w-7 h-7 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-cream">
                {t("successTitle")}
              </h2>
              <p className="text-sm text-cream/50 mt-1">
                {t("successSubtitle")}
              </p>
            </div>
            <div className="flex items-center justify-center gap-2 text-xs text-cream/40">
              <Spinner size="sm" />
              <span>{t("returningToApp")}</span>
            </div>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                window.location.href = `ellul://connected?domain=${encodeURIComponent(connected.domain)}`;
              }}
            >
              <Laptop className="w-4 h-4 mr-2" />
              {t("openApp")}
            </Button>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <Card className="w-full max-w-sm border-cream/[0.06] bg-[#13131A]/80 backdrop-blur">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full border border-red-500/20 bg-red-500/5">
              <Cloud className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-cream mb-1">
                {t("errorTitle")}
              </h2>
              <p className="text-sm text-red-400">{error}</p>
            </div>
            <p className="text-xs text-cream/40">{t("errorHint")}</p>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  if (blockReason?.type === "no_server") {
    return (
      <Shell>
        <Card className="w-full max-w-sm border-cream/[0.06] bg-[#13131A]/80 backdrop-blur">
          <CardContent className="pt-6 text-center space-y-5">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full border border-cream/[0.08] bg-cream/[0.03]">
              <Cloud className="w-5 h-5 text-cream/60" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-cream">
                {t("noServerTitle")}
              </h2>
              <p className="text-sm text-cream/50 mt-1">
                {t("noServerSubtitle")}
              </p>
            </div>
            <Button asChild className="w-full">
              <a href="/dashboard">{t("createWorkspace")}</a>
            </Button>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  if (blockReason?.type === "not_active") {
    return (
      <Shell>
        <Card className="w-full max-w-sm border-cream/[0.06] bg-[#13131A]/80 backdrop-blur">
          <CardContent className="pt-6 text-center space-y-5">
            <Spinner size="lg" color="primary" />
            <div>
              <h2 className="text-lg font-semibold text-cream">
                {t("notReadyTitle")}
              </h2>
              <p className="text-sm text-cream/50 mt-1">
                {t("notReadySubtitle", { status: blockReason.status })}
              </p>
            </div>
            <Button variant="outline" asChild>
              <a href="/dashboard">
                <ArrowLeft className="w-4 h-4 mr-1" />
                Dashboard
              </a>
            </Button>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  return <LoadingScreen message={t("connectingMessage")} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center px-4 gap-6"
      style={{
        background:
          "radial-gradient(ellipse at 20% 0%, rgba(245,239,230,0.04) 0%, transparent 60%), " +
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

export default function ConnectPage() {
  const t = useTranslations("console.appConnect");
  return (
    <Suspense fallback={<LoadingScreen message={t("loadingFallback")} />}>
      <ConnectContent />
    </Suspense>
  );
}
