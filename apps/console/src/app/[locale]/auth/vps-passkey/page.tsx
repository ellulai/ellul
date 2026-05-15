// SPDX-License-Identifier: MIT
"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { startAuthentication } from "@simplewebauthn/browser";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

type Status = "loading" | "authenticating" | "success" | "error";

function PasskeyFlow() {
  const params = useSearchParams();
  const flowId = params.get("flow_id");
  const optionsB64 = params.get("options");
  const callback = params.get("callback");
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!flowId && !optionsB64) {
      setStatus("error");
      setErrorMsg("Missing parameters. Please try again from the app.");
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        let optionsJSON: Parameters<typeof startAuthentication>[0]["optionsJSON"];

        if (optionsB64) {
          optionsJSON = JSON.parse(atob(optionsB64));
        } else {
          const optionsRes = await fetch(
            `${API_URL}/api/auth/native/vps-auth-data?flow_id=${encodeURIComponent(flowId!)}&type=options`,
          );
          const optionsBody = await optionsRes.json();
          if (optionsBody.status !== "complete" || !optionsBody.data) {
            throw new Error("No options available. Please try again from the app.");
          }
          optionsJSON = optionsBody.data;
        }
        if (cancelled) return;

        setStatus("authenticating");
        const assertion = await startAuthentication({ optionsJSON });
        if (cancelled) return;

        if (callback) {
          const assertionB64 = btoa(JSON.stringify(assertion));
          window.location.href = `${callback}?assertion=${encodeURIComponent(assertionB64)}`;
          setStatus("success");
          return;
        }

        if (flowId) {
          await fetch(`${API_URL}/api/auth/native/vps-auth-data`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ flowId, type: "assertion", data: assertion }),
          });
        }

        setStatus("success");
      } catch (err: unknown) {
        if (!cancelled) {
          setStatus("error");
          setErrorMsg(err instanceof Error ? err.message : "Authentication failed. Please try again.");
          if (callback) {
            setTimeout(() => {
              window.location.href = `${callback}?error=${encodeURIComponent(
                err instanceof Error ? err.message : "Authentication failed",
              )}`;
            }, 2000);
          }
        }
      }
    })();

    return () => { cancelled = true; };
  }, [flowId, optionsB64, callback]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-ink">
      <div className="text-center max-w-sm bg-[#13131A] border border-[rgba(245,239,230,0.07)] rounded-2xl px-14 py-12">
        {status === "loading" && (
          <>
            <Spinner />
            <h2 className="text-lg font-semibold text-cream mb-2">Loading...</h2>
          </>
        )}
        {status === "authenticating" && (
          <>
            <Icon d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
            <h2 className="text-lg font-semibold text-cream mb-2">Authenticate</h2>
            <p className="text-sm text-cream/50">Use your passkey when prompted.</p>
          </>
        )}
        {status === "success" && (
          <>
            <Icon d="M5 13l4 4L19 7" />
            <h2 className="text-lg font-semibold text-cream mb-2">Authenticated</h2>
            <p className="text-sm text-cream/50">You can close this tab and return to the app.</p>
          </>
        )}
        {status === "error" && (
          <>
            <Icon d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" error />
            <h2 className="text-lg font-semibold text-cream mb-2">Authentication Failed</h2>
            <p className="text-sm text-cream/50">{errorMsg}</p>
          </>
        )}
      </div>
    </div>
  );
}

function Icon({ d, error }: { d: string; error?: boolean }) {
  const color = error ? "terra" : "sodium";
  return (
    <div className={`w-12 h-12 rounded-full bg-${color}/10 flex items-center justify-center mx-auto mb-6`}>
      <svg className={`w-6 h-6 text-${color}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d={d} />
      </svg>
    </div>
  );
}

function Spinner() {
  return (
    <div className="w-12 h-12 rounded-full bg-sodium/10 flex items-center justify-center mx-auto mb-6">
      <svg className="w-6 h-6 text-sodium animate-spin" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    </div>
  );
}

export default function VpsPasskeyPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-ink">
        <div className="text-center max-w-sm bg-[#13131A] border border-[rgba(245,239,230,0.07)] rounded-2xl px-14 py-12">
          <Spinner />
          <h2 className="text-lg font-semibold text-cream mb-2">Loading...</h2>
        </div>
      </div>
    }>
      <PasskeyFlow />
    </Suspense>
  );
}
