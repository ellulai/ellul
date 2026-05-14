// SPDX-License-Identifier: MIT
"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2, RefreshCw, Trash2, Check } from "lucide-react";
import { useTranslations } from "next-intl";

type Status =
  | "pending_validation"
  | "validating"
  | "issuing_cert"
  | "active"
  | "validation_failed"
  | "cert_failed"
  | "suspended";

interface VerificationRecord {
  type: string;
  name: string;
  value: string;
}

interface DomainState {
  hostname: string | null;
  status: Status | null;
  verifiedAt: string | null;
  lastError: string | null;
  verification: VerificationRecord | null;
}

interface Props {
  serverId: string;
  isSovereign: boolean;
  apiUrl: string;
}

function useStatusLabels(): Record<Status, { label: string; tone: "pending" | "progress" | "success" | "error" }> {
  const t = useTranslations("console.customDomain");
  return {
    pending_validation: { label: t("statusPendingValidation"), tone: "pending" },
    validating: { label: t("statusValidating"), tone: "progress" },
    issuing_cert: { label: t("statusIssuingCert"), tone: "progress" },
    active: { label: t("statusActive"), tone: "success" },
    validation_failed: { label: t("statusValidationFailed"), tone: "error" },
    cert_failed: { label: t("statusCertFailed"), tone: "error" },
    suspended: { label: t("statusSuspended"), tone: "error" },
  };
}

function isTerminal(status: Status | null): boolean {
  return status === "active" || status === "suspended";
}

export function ServerSettingsDomains({ serverId, isSovereign, apiUrl }: Props) {
  const t = useTranslations("console.customDomain");
  const STATUS_LABELS = useStatusLabels();
  const [state, setState] = useState<DomainState | null>(null);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<"name" | "value" | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/servers/${serverId}/custom-domain`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DomainState;
      setState(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, serverId]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  // Auto-poll while the state is non-terminal.
  useEffect(() => {
    if (!state?.status || isTerminal(state.status)) return;
    const id = setInterval(fetchState, 10_000);
    return () => clearInterval(id);
  }, [state?.status, fetchState]);

  const onSubmit = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`${apiUrl}/api/servers/${serverId}/custom-domain`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: input.trim().toLowerCase(), termsAccepted: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || t("requestFailed"));
      setInput("");
      setTermsAccepted(false);
      await fetchState();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [apiUrl, serverId, input, fetchState, t]);

  const onRemove = useCallback(async () => {
    if (!confirm(t("removeConfirm"))) return;
    setSubmitting(true);
    try {
      await fetch(`${apiUrl}/api/servers/${serverId}/custom-domain`, {
        method: "DELETE",
        credentials: "include",
      });
      await fetchState();
    } finally {
      setSubmitting(false);
    }
  }, [apiUrl, serverId, fetchState, t]);

  const onVerifyNow = useCallback(async () => {
    setSubmitting(true);
    try {
      await fetch(`${apiUrl}/api/servers/${serverId}/custom-domain/verify`, {
        method: "POST",
        credentials: "include",
      });
      await fetchState();
    } finally {
      setSubmitting(false);
    }
  }, [apiUrl, serverId, fetchState]);

  const copy = useCallback(async (field: "name" | "value", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {}
  }, []);

  if (isSovereign) {
    return (
      <div className="p-5">
        <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-5">
          <h3 className="text-sm font-medium text-cream mb-2">{t("title")}</h3>
          <p className="text-xs text-cream/60 leading-relaxed">
            {t("sovereignNotice")}
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-5 flex items-center gap-2 text-xs text-cream/60">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("loading")}
      </div>
    );
  }

  // Active domain
  if (state?.hostname && state?.status === "active") {
    return (
      <div className="p-4 sm:p-5 space-y-4">
        <section className="rounded-xl border border-sodium/20 bg-sodium/[0.04] p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Check className="h-3.5 w-3.5 text-sodium" />
                <h3 className="text-sm font-medium text-cream">{state.hostname}</h3>
              </div>
              <p className="text-[11px] text-cream/60">
                {t("activeNotice", { hostname: state.hostname })}
              </p>
            </div>
            <button
              onClick={onRemove}
              disabled={submitting}
              className="shrink-0 px-2.5 py-1.5 rounded-md text-[11px] text-cream/60 hover:text-terra hover:bg-terra/10 transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              <Trash2 className="h-3 w-3" />
              {t("remove")}
            </button>
          </div>
        </section>
        <p className="text-[11px] text-cream/45 px-1 leading-relaxed">
          {t("passkeyNotice", { hostname: state.hostname })}
        </p>
      </div>
    );
  }

  // Pending / in-flight
  if (state?.hostname && state.status && !isTerminal(state.status)) {
    const label = STATUS_LABELS[state.status];
    return (
      <div className="p-4 sm:p-5 space-y-4">
        <section className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4">
          <div className="flex items-center gap-2 mb-2">
            <Loader2 className="h-3.5 w-3.5 text-cream/60 animate-spin" />
            <h3 className="text-sm font-medium text-cream">{state.hostname}</h3>
          </div>
          <p className="text-[11px] text-cream/60">{label.label}</p>
        </section>
        {state.verification && (
          <section className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4">
            <h4 className="text-xs font-medium text-cream mb-2">{t("dnsVerification")}</h4>
            <p className="text-[11px] text-cream/60 mb-3 leading-relaxed">
              {t("dnsVerificationHint", { type: state.verification.type, hostname: state.hostname })}
            </p>
            <div className="space-y-2">
              <DnsFieldRow
                label={t("dnsLabelName")}
                value={state.verification.name}
                copied={copiedField === "name"}
                onCopy={() => copy("name", state.verification!.name)}
              />
              <DnsFieldRow
                label={t("dnsLabelValue")}
                value={state.verification.value}
                copied={copiedField === "value"}
                onCopy={() => copy("value", state.verification!.value)}
              />
            </div>
          </section>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={onVerifyNow}
            disabled={submitting}
            className="px-3 py-1.5 rounded-md text-xs text-cream/75 hover:text-cream bg-cream/[0.04] hover:bg-cream/[0.08] transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${submitting ? "animate-spin" : ""}`} />
            {t("checkStatusNow")}
          </button>
          <button
            onClick={onRemove}
            disabled={submitting}
            className="px-3 py-1.5 rounded-md text-xs text-cream/60 hover:text-terra hover:bg-terra/10 transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
            {t("cancel")}
          </button>
        </div>
        {state.lastError && (
          <p className="text-[11px] text-terra px-1">{state.lastError}</p>
        )}
      </div>
    );
  }

  // Empty state — add a domain
  const canSubmit =
    input.trim().length > 0 && termsAccepted && !submitting;

  return (
    <div className="p-4 sm:p-5 space-y-4">
      <section className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4">
        <h3 className="text-sm font-medium text-cream mb-1">{t("title")}</h3>
        <p className="text-[11px] text-cream/60 mb-4 leading-relaxed">
          {t("intro")}
        </p>
        <label className="block text-[11px] text-cream/60 mb-1">{t("yourDomain")}</label>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("domainPlaceholder")}
          className="w-full px-3 py-2 rounded-md bg-cream/[0.03] border border-cream/[0.08] text-sm text-cream placeholder-cream/40 focus:outline-none focus:border-sodium/40"
          disabled={submitting}
        />
        <label className="flex items-start gap-2 mt-3 text-[11px] text-cream/60 cursor-pointer">
          <input
            type="checkbox"
            checked={termsAccepted}
            onChange={(e) => setTermsAccepted(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            {t("termsAccept")}
          </span>
        </label>
        {error && (
          <p className="mt-3 text-[11px] text-terra">{error}</p>
        )}
        <button
          onClick={onSubmit}
          disabled={!canSubmit}
          className="mt-4 w-full px-4 py-2 rounded-md bg-sodium/10 border border-sodium/25 text-sodium hover:bg-sodium/15 hover:border-sodium/40 transition-all text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
          {t("addDomain")}
        </button>
      </section>
    </div>
  );
}

function DnsFieldRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 w-12 text-[10px] text-cream/45 uppercase tracking-wide">
        {label}
      </span>
      <code className="flex-1 px-2 py-1 rounded bg-black/30 border border-cream/[0.06] text-[11px] text-cream/85 font-mono overflow-x-auto whitespace-nowrap">
        {value}
      </code>
      <button
        onClick={onCopy}
        className="shrink-0 p-1.5 rounded text-cream/60 hover:text-cream hover:bg-cream/[0.06] transition-colors"
      >
        {copied ? <Check className="h-3 w-3 text-sodium" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}
