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

function ConnectContent() {
  const t = useTranslations("console.appConnect");
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [done, setDone] = useState(false);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const dbg = (msg: string) => {
    console.log(`[connect-debug] ${msg}`);
    setDebugLog((prev) => [...prev, `${new Date().toISOString().slice(11, 23)} ${msg}`]);
  };

  const params =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const urlConnectId = params.get("connect_id");
  const storedConnectId = typeof window !== "undefined" ? sessionStorage.getItem("ellul_connect_id") : null;
  const connectId = urlConnectId || storedConnectId;

  useEffect(() => {
    dbg(`url_connect_id=${urlConnectId || "null"} stored=${storedConnectId || "null"} effective=${connectId || "null"}`);
    dbg(`full_url=${typeof window !== "undefined" ? window.location.href : "ssr"}`);
    dbg(`API_URL=${API_URL}`);
    if (urlConnectId) {
      sessionStorage.setItem("ellul_connect_id", urlConnectId);
      dbg("persisted connect_id to sessionStorage");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      dbg("init: calling getSession()...");
      try {
        const { data } = await getSession();
        dbg(`init: getSession returned data=${!!data} user=${data?.user?.email || "null"}`);
        if (!data) {
          dbg("init: no session → showing auth buttons");
          setNeedsAuth(true);
          return;
        }

        if (!connectId) {
          dbg("init: NO connectId after auth → setDone(true) WITHOUT calling connect-complete");
          setDone(true);
          return;
        }

        dbg(`init: calling connect-complete with connectId=${connectId.slice(0, 8)}...`);
        const res = await fetch(`${API_URL}/api/auth/native/connect-complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ connectId }),
        });

        const body = await res.text();
        dbg(`init: connect-complete status=${res.status} body=${body}`);

        if (!cancelled) {
          if (res.ok) {
            sessionStorage.removeItem("ellul_connect_id");
            dbg("init: SUCCESS — connect-complete returned ok, showing done screen");
            setDone(true);
          } else {
            dbg(`init: FAIL — connect-complete returned ${res.status}: ${body}`);
            setError(`connect-complete failed: ${res.status} ${body}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dbg(`init: EXCEPTION — ${msg}`);
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
        {debugPanel}
      </Shell>
    );
  }

  const debugPanel = debugLog.length > 0 && (
    <div className="w-full max-w-lg mt-4 p-3 rounded-lg bg-black/60 border border-cream/10 font-mono text-[10px] leading-relaxed text-cream/70 max-h-48 overflow-y-auto">
      {debugLog.map((line, i) => <div key={i}>{line}</div>)}
    </div>
  );

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
        {debugPanel}
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
        {debugPanel}
      </Shell>
    );
  }

  return (
    <Shell>
      <LoadingScreen message={t("connectingMessage")} />
      {debugPanel}
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
