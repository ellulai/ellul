"use client";

import { useEffect, useState, Suspense } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/types";
import { API_URL } from "@/lib/api";
import { LoadingScreen } from "@/components/ui/spinner";
import { Card, CardContent } from "@/components/ui/card";
import { Fingerprint, AlertCircle } from "lucide-react";

const CALLBACK_SCHEME = "ellul-auth";

function VpsAuthContent() {
  const [status, setStatus] = useState<"loading" | "authenticating" | "done" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flowId = params.get("flow_id");
    const server = params.get("server");

    if (!flowId || !server) {
      setError("Missing flow_id or server parameter");
      setStatus("error");
      return;
    }

    let cancelled = false;

    const run = async () => {
      try {
        let options: PublicKeyCredentialRequestOptionsJSON | null = null;
        for (let i = 0; i < 30; i++) {
          const res = await fetch(
            `${API_URL}/api/auth/native/vps-auth-data?flow_id=${flowId}&type=options`
          );
          const data = await res.json();
          if (data.status === "complete") {
            options = data.data as PublicKeyCredentialRequestOptionsJSON;
            break;
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        if (!options || cancelled) {
          if (!cancelled) {
            setError("Timeout waiting for authentication options");
            setStatus("error");
          }
          return;
        }

        setStatus("authenticating");
        const assertion = await startAuthentication({ optionsJSON: options });

        if (cancelled) return;

        await fetch(`${API_URL}/api/auth/native/vps-auth-data`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId, type: "assertion", data: assertion }),
        });

        setStatus("done");
        window.location.href = `${CALLBACK_SCHEME}://complete`;
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatus("error");
        setTimeout(() => {
          window.location.href = `${CALLBACK_SCHEME}://error?msg=${encodeURIComponent(msg)}`;
        }, 2000);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Shell>
        <Card className="w-full max-w-sm border-cream/[0.06] bg-[#13131A]/80 backdrop-blur">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full border border-red-500/20 bg-red-500/5">
              <AlertCircle className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-cream mb-1">
                Authentication failed
              </h2>
              <p className="text-sm text-red-400">{error}</p>
            </div>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  if (status === "authenticating") {
    return (
      <Shell>
        <Card className="w-full max-w-sm border-cream/[0.06] bg-[#13131A]/80 backdrop-blur">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full border border-sodium/20 bg-sodium/5">
              <Fingerprint className="w-7 h-7 text-sodium" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-cream">
                Authenticate with passkey
              </h2>
              <p className="text-sm text-cream/50 mt-1">
                Use Touch ID or your security key to sign in.
              </p>
            </div>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <LoadingScreen message="Preparing authentication..." />
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

export default function VpsAuthPage() {
  return (
    <Suspense fallback={<LoadingScreen message="Loading..." />}>
      <VpsAuthContent />
    </Suspense>
  );
}
