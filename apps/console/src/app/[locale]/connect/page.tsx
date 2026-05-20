// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useState, Suspense } from "react";
import { useTranslations } from "next-intl";
import { getSession } from "@/lib/auth-client";
import { LoadingScreen, Spinner } from "@/components/ui/spinner";
import { Card, CardContent } from "@/components/ui/card";
import { API_URL } from "@/lib/api";
import { OAuthSignIn } from "@/components/auth/oauth-buttons";
import { CheckCircle2, Cloud } from "lucide-react";
import { isTauriApp } from "@/lib/utils";

const CONSOLE_URL = process.env.NEXT_PUBLIC_CONSOLE_URL || "https://console.ellul.ai";
const TAURI_API_URL = CONSOLE_URL.replace("console.", "api.");

async function tauriEstablish(connectId: string) {
  const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
  if (!invoke) return;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const data = await invoke("poll_connect", { connectId });
      if (data.status === "complete" && data.code) {
        const domain = data.hasServer ? data.serverDomain : null;
        await invoke("set_app_mode", { mode: "cloud", cloudDomain: domain });
        localStorage.removeItem("ellul_pending_connect_id");
        const establishUrl = `${TAURI_API_URL}/api/auth/native/session/establish?code=${encodeURIComponent(data.code)}&redirect=${encodeURIComponent(CONSOLE_URL + "/dashboard")}`;
        window.location.replace(establishUrl);
        return;
      }
    } catch {}
  }
}

function ConnectContent() {
  const t = useTranslations("console.appConnect");
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [done, setDone] = useState(false);

  const params =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const urlConnectId = params.get("connect_id");
  const storedConnectId = typeof window !== "undefined" ? sessionStorage.getItem("ellul_connect_id") : null;
  const connectId = urlConnectId || storedConnectId;

  useEffect(() => {
    if (urlConnectId) {
      sessionStorage.setItem("ellul_connect_id", urlConnectId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const { data } = await getSession();
        if (!data) {
          setNeedsAuth(true);
          return;
        }

        if (!connectId) {
          setDone(true);
          return;
        }

        const res = await fetch(`${API_URL}/api/auth/native/connect-complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ connectId }),
        });

        const body = await res.text();

        if (!cancelled) {
          if (res.ok) {
            sessionStorage.removeItem("ellul_connect_id");
            if (isTauriApp() && connectId) {
              await tauriEstablish(connectId);
            } else {
              setDone(true);
            }
          } else {
            setError(`connect-complete failed: ${res.status} ${body}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!cancelled) {
          setError(msg);
        }
      }
    };
    init();

    return () => { cancelled = true; };
  }, [connectId, t]);

  if (needsAuth) {
    const callbackPath = connectId
      ? `/connect?connect_id=${connectId}`
      : "/connect";
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

            <OAuthSignIn callbackPath={callbackPath} />
          </CardContent>
        </Card>

      </Shell>
    );
  }

  if (done) {
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

  return (
    <Shell>
      <LoadingScreen message={t("connectingMessage")} />
    </Shell>
  );
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
