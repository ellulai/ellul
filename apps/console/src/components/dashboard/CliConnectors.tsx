// SPDX-License-Identifier: MIT
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Eye, EyeOff, ExternalLink, Key, LogIn, X, Copy, Loader2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ClaudeLogo, OpenAILogo, CursorLogo, GeminiLogo, OpenRouterLogo, OpenCodeLogo, GrokLogo } from "@/components/ui/ai-logos";
import { useVpsBridge } from "@/lib/vps-bridge";
import { getIframeBaseUrl } from "@/lib/domains";
import { isTauriApp } from "@/lib/utils";

// ANSI renderer ported from AuthSetupModal. Translates cursor moves to
// whitespace and reassembles URLs that Ink wraps across lines.
const ANSI_CURSOR_FWD = /\x1B\[(\d*)C/g;
const ANSI_CURSOR_DOWN = /\x1B\[(\d*)B/g;
const ANSI_CSI = /\x1B\[[0-9;?]*[a-zA-Z]/g;
const ANSI_OSC = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
const ANSI_TWOBYTE = /\x1B[()][AB012]/g;
const ANSI_SINGLE = /\x1B[=>NOM78HcDZ<]/g;
const ANSI_PRIVATE = /\x1B\[\?[0-9;]*[hl]/g;
const CONTROL_CHARS = /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g;

function stripAnsi(input: string): string {
  const stripped = input
    .replace(ANSI_CURSOR_FWD, (_, n: string) => " ".repeat(n ? Math.min(parseInt(n, 10), 200) : 1))
    .replace(ANSI_CURSOR_DOWN, (_, n: string) => "\n".repeat(n ? parseInt(n, 10) || 1 : 1))
    .replace(ANSI_PRIVATE, "").replace(ANSI_CSI, "").replace(ANSI_OSC, "")
    .replace(ANSI_TWOBYTE, "").replace(ANSI_SINGLE, "").replace(CONTROL_CHARS, "")
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = stripped.split("\n");
  const out: string[] = [];
  const URL_CONT = /^[a-zA-Z0-9%&=_.~:/?#[\]@!$'()+,;-]+$/;
  for (const raw of lines) {
    if (raw.trim() === "") { out.push(raw); continue; }
    const trimmed = raw.trim();
    if (URL_CONT.test(trimmed)) {
      let prev = out.length - 1;
      while (prev >= 0 && out[prev]!.trim() === "") prev -= 1;
      if (prev >= 0 && /https?:\/\/[^\s]*$/.test(out[prev]!.trimEnd())) {
        out[prev] = out[prev]!.trimEnd() + trimmed;
        continue;
      }
    }
    out.push(raw);
  }
  return out.join("\n");
}

const URL_RE = /https?:\/\/[a-zA-Z0-9%&=_.~:/?#[\]@!$'()+,;*-]+/g;

function extractAuthUrl(output: string): string | null {
  const matches = output.match(URL_RE);
  if (!matches?.length) return null;
  let best = matches[0]!;
  for (const m of matches) if (m.length > best.length) best = m;
  return best;
}

function extractDeviceCode(output: string): string | null {
  const m = output.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/);
  return m ? m[0] : null;
}

interface ConnectorInfo {
  connected: boolean;
  hasApiKey: boolean;
  hasSignIn: boolean;
}

interface ProviderStatus {
  connected: boolean;
}

interface ConnectorDef {
  id: string;
  tool: string | null;
  label: string;
  subtitle: string;
  provider: string;
  icon: React.ReactNode;
  hasSignIn: boolean;
  keyUrl: string;
  keyPlaceholder: string;
}

const CONNECTORS: ConnectorDef[] = [
  {
    id: "claude",
    tool: "claude",
    label: "Claude Code",
    subtitle: "Anthropic",
    provider: "anthropic",
    icon: <ClaudeLogo className="h-4 w-4" />,
    hasSignIn: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-...",
  },
  {
    id: "codex",
    tool: "codex",
    label: "Codex",
    subtitle: "OpenAI",
    provider: "openai",
    icon: <OpenAILogo className="h-4 w-4" />,
    hasSignIn: true,
    keyUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-...",
  },
  {
    id: "cursor",
    tool: "cursor",
    label: "Cursor",
    subtitle: "Cursor",
    provider: "cursor",
    icon: <CursorLogo className="h-4 w-4" />,
    hasSignIn: true,
    keyUrl: "",
    keyPlaceholder: "",
  },
  {
    id: "opencode",
    tool: null,
    label: "OpenCode",
    subtitle: "OpenCode",
    provider: "opencode",
    icon: <OpenCodeLogo className="h-4 w-4" />,
    hasSignIn: false,
    keyUrl: "",
    keyPlaceholder: "",
  },
  {
    id: "google",
    tool: null,
    label: "Google AI",
    subtitle: "Gemini",
    provider: "google",
    icon: <GeminiLogo className="h-4 w-4" />,
    hasSignIn: false,
    keyUrl: "https://aistudio.google.com/apikey",
    keyPlaceholder: "AIza...",
  },
  {
    id: "openrouter",
    tool: null,
    label: "OpenRouter",
    subtitle: "Multi-model",
    provider: "openrouter",
    icon: <OpenRouterLogo className="h-4 w-4" />,
    hasSignIn: false,
    keyUrl: "https://openrouter.ai/settings/keys",
    keyPlaceholder: "sk-or-...",
  },
  {
    id: "grok",
    tool: "grok",
    label: "Grok Build",
    subtitle: "xAI",
    provider: "xai",
    icon: <GrokLogo className="h-4 w-4" />,
    hasSignIn: true,
    keyUrl: "https://console.x.ai/",
    keyPlaceholder: "xai-...",
  },
];

interface CliConnectorsProps {
  serverDomain: string;
  connectors?: Record<string, ConnectorInfo>;
  providers?: Record<string, ProviderStatus>;
  isLoading?: boolean;
}

export function CliConnectors({ serverDomain, connectors, providers, isLoading }: CliConnectorsProps) {
  const t = useTranslations("console.connectors");
  const queryClient = useQueryClient();
  const { send: vpsSend } = useVpsBridge();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [signInTool, setSignInTool] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ provider: string; label: string } | null>(null);

  const saveMutation = useMutation({
    mutationFn: async ({ provider, apiKey }: { provider: string; apiKey: string }) => {
      await vpsSend("connector_save_key", { provider, apiKey });
    },
    onSuccess: () => {
      setExpandedKey(null);
      queryClient.invalidateQueries({ queryKey: ["vps-features", serverDomain] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async ({ provider }: { provider: string }) => {
      await vpsSend("connector_remove_key", { provider });
    },
    onSuccess: () => {
      setConfirmRemove(null);
      queryClient.invalidateQueries({ queryKey: ["vps-features", serverDomain] });
    },
  });

  function getStatus(def: ConnectorDef): { connected: boolean; method: string | null } {
    if (def.tool && connectors?.[def.tool]) {
      const c = connectors[def.tool]!;
      return {
        connected: c.connected,
        method: c.hasSignIn ? "sign-in" : c.hasApiKey ? "api-key" : null,
      };
    }
    if (providers?.[def.provider]) {
      return {
        connected: providers[def.provider]!.connected,
        method: providers[def.provider]!.connected ? "api-key" : null,
      };
    }
    return { connected: false, method: null };
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-cream/[0.08] p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Skeleton className="h-7 w-7 rounded-md" />
                <div className="space-y-1.5">
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="h-2.5 w-16" />
                </div>
              </div>
              <Skeleton className="h-7 w-16 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {CONNECTORS.map((def) => {
        const status = getStatus(def);
        return (
          <ConnectorRow
            key={def.id}
            def={def}
            status={status}
            expanded={expandedKey === def.id}
            onExpand={() => setExpandedKey(expandedKey === def.id ? null : def.id)}
            onSaveKey={(apiKey) => saveMutation.mutate({ provider: def.provider, apiKey })}
            onRemoveKey={() => setConfirmRemove({ provider: def.provider, label: def.label })}
            onSignIn={() => setSignInTool(def.tool)}
            isSaving={saveMutation.isPending}
            isRemoving={removeMutation.isPending}
          />
        );
      })}

      {saveMutation.isError && (
        <p className="text-xs text-terra mt-2">
          {(saveMutation.error as Error)?.message || t("failedToSave")}
        </p>
      )}

      <SignInDialog
        tool={signInTool}
        serverDomain={serverDomain}
        onClose={() => {
          setSignInTool(null);
          setTimeout(() => {
            queryClient.invalidateQueries({ queryKey: ["vps-features", serverDomain] });
          }, 1500);
        }}
      />

      {/* Remove key confirmation */}
      <Dialog open={!!confirmRemove} onOpenChange={(open) => { if (!open) setConfirmRemove(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("removeTitle")}</DialogTitle>
            <DialogDescription>
              {t("removeDescription", { label: confirmRemove?.label ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmRemove(null)}
              disabled={removeMutation.isPending}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (confirmRemove) {
                  removeMutation.mutate({ provider: confirmRemove.provider });
                }
              }}
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending ? (
                <><Spinner size="sm" className="mr-1.5" /> {t("removing")}</>
              ) : (
                t("removeKey")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConnectorRow({
  def,
  status,
  expanded,
  onExpand,
  onSaveKey,
  onRemoveKey,
  onSignIn,
  isSaving,
  isRemoving,
}: {
  def: ConnectorDef;
  status: { connected: boolean; method: string | null };
  expanded: boolean;
  onExpand: () => void;
  onSaveKey: (key: string) => void;
  onRemoveKey: () => void;
  onSignIn: () => void;
  isSaving: boolean;
  isRemoving: boolean;
}) {
  const t = useTranslations("console.connectors");
  const [keyValue, setKeyValue] = useState("");
  const [showKey, setShowKey] = useState(false);

  const handleSave = () => {
    if (!keyValue.trim()) return;
    onSaveKey(keyValue.trim());
    setKeyValue("");
    setShowKey(false);
  };

  const showApiKey = def.provider !== "cursor";

  return (
    <div className={`rounded-lg border p-3 transition-colors ${
      status.connected
        ? "border-emerald-500/20 bg-emerald-500/[0.03]"
        : "border-cream/[0.08] bg-cream/[0.02]"
    }`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`p-1.5 rounded-md ${
            status.connected ? "bg-emerald-500/10" : "bg-cream/[0.06]"
          }`}>
            {def.icon}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-cream">{def.label}</span>
              <span className="text-[10px] text-cream/40">{def.subtitle}</span>
            </div>
            {status.connected && (
              <div className="flex items-center gap-1 mt-0.5">
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <span className="text-[10px] text-emerald-400/80">
                  {status.method === "sign-in" ? t("signedIn") : t("apiKey")}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {status.connected ? (
            <>
              {showApiKey && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px] border-cream/[0.08] px-2"
                  onClick={onExpand}
                >
                  <Key className="h-3 w-3 mr-1" />
                  {t("update")}
                </Button>
              )}
              {showApiKey && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px] border-terra/20 text-terra hover:bg-terra/10 px-2"
                  onClick={onRemoveKey}
                  disabled={isRemoving}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </>
          ) : (
            <>
              {showApiKey && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px] border-cream/[0.08] px-2"
                  onClick={onExpand}
                >
                  <Key className="h-3 w-3 mr-1" />
                  {t("apiKey")}
                </Button>
              )}
              {def.hasSignIn && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px] border-sodium/30 text-sodium hover:bg-sodium/10 px-2"
                  onClick={onSignIn}
                >
                  <LogIn className="h-3 w-3 mr-1" />
                  {t("signIn")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {expanded && showApiKey && (
        <div className="mt-3 pt-3 border-t border-cream/[0.06] space-y-2">
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
              placeholder={def.keyPlaceholder}
              className="w-full rounded-md border border-cream/[0.08] bg-cream/[0.03] px-3 py-2 pr-9 text-sm text-cream placeholder:text-cream/30 focus:border-sodium/50 focus:outline-none"
              onKeyDown={(e) => e.key === "Enter" && handleSave()}
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-cream/45 hover:text-cream"
            >
              {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleSave}
                disabled={isSaving || !keyValue.trim()}
                className="h-7 text-[11px] bg-sodium hover:bg-sodium/90"
              >
                {isSaving ? <Spinner size="sm" /> : t("save")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => { onExpand(); setKeyValue(""); setShowKey(false); }}
                className="h-7 text-[11px] border-cream/[0.08]"
              >
                {t("cancel")}
              </Button>
            </div>
            {def.keyUrl && (
              <a
                href={def.keyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] text-cream/50 hover:text-cream transition-colors"
              >
                {t("getKey")} <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SignInDialog({
  tool,
  serverDomain,
  onClose,
}: {
  tool: string | null;
  serverDomain: string;
  onClose: () => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [rawOutput, setRawOutput] = useState("");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent">("idle");
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [directToken, setDirectToken] = useState("");
  const [directState, setDirectState] = useState<"idle" | "submitting" | "error">("idle");
  const [directError, setDirectError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLPreElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const vpsUrl = serverDomain.startsWith("localhost")
    ? getIframeBaseUrl(serverDomain, isTauriApp())
    : `https://${serverDomain}`;
  const label = tool === "claude" ? "Claude Code" : tool === "codex" ? "Codex" : tool === "cursor" ? "Cursor" : tool ?? "";
  const isOpen = tool !== null;

  const cleanOutput = useMemo(() => stripAnsi(rawOutput), [rawOutput]);
  const authUrl = useMemo(() => extractAuthUrl(cleanOutput), [cleanOutput]);
  const deviceCode = useMemo(() => extractDeviceCode(cleanOutput), [cleanOutput]);

  const success = exitCode === 0;
  const failed = (exitCode !== null && exitCode !== 0) || !!error;
  const running = exitCode === null && !error;

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
    setCopyState("copied");
    setTimeout(() => setCopyState("idle"), 1800);
  }, []);

  const startSession = useCallback(async () => {
    if (!tool) return;
    setRawOutput("");
    setExitCode(null);
    setError(null);
    setInputValue("");
    setSendState("idle");
    setDirectToken("");
    setDirectState("idle");
    setDirectError(null);

    try {
      const res = await fetch(`${vpsUrl}/_auth/bridge/agents/auth/start`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool }),
      });
      if (!res.ok) {
        setError(`Failed to start auth session: ${res.status}`);
        return;
      }
      const data = await res.json();
      const sid = data.sessionId as string;
      setSessionId(sid);
      sessionIdRef.current = sid;

      const es = new EventSource(
        `${vpsUrl}/_auth/bridge/agents/auth/${sid}/events`,
        { withCredentials: true },
      );
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === "data") {
            setRawOutput((prev) => (prev + parsed.chunk).slice(-128_000));
          } else if (parsed.type === "exit") {
            setExitCode(parsed.exitCode);
            es.close();
          } else if (parsed.type === "error") {
            setError(parsed.message);
            es.close();
          }
        } catch {}
      };
      es.onerror = () => {};
    } catch (err) {
      setError((err as Error).message);
    }
  }, [tool, vpsUrl]);

  useEffect(() => {
    if (isOpen && tool) startSession();
    if (!isOpen) {
      cleanup();
      setRawOutput("");
      setExitCode(null);
      setError(null);
      sessionIdRef.current = null;
    }
    return cleanup;
  }, [isOpen, tool, startSession, cleanup]);

  const sendInput = useCallback(async () => {
    const id = sessionIdRef.current;
    const trimmed = inputValue.trim();
    if (!id || !trimmed) return;
    setSendState("sending");
    try {
      const res = await fetch(`${vpsUrl}/_auth/bridge/agents/auth/${id}/input`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: trimmed }),
      });
      if (res.ok) {
        setInputValue("");
        setSendState("sent");
        setTimeout(() => setSendState((s) => s === "sent" ? "idle" : s), 1500);
      } else {
        setSendState("idle");
      }
    } catch {
      setSendState("idle");
    }
  }, [inputValue, vpsUrl]);

  const submitDirectToken = useCallback(async () => {
    const trimmed = directToken.trim();
    if (!trimmed.startsWith("sk-ant-oat01-")) {
      setDirectError("Token must start with sk-ant-oat01-");
      setDirectState("error");
      return;
    }
    setDirectState("submitting");
    setDirectError(null);
    try {
      const res = await fetch(`${vpsUrl}/_auth/bridge/agents/auth/claude-token`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: trimmed }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setDirectError(err.error ?? `Server returned ${res.status}`);
        setDirectState("error");
        return;
      }
      cleanup();
      setDirectToken("");
      setDirectState("idle");
      setExitCode(0);
    } catch (e) {
      setDirectError((e as Error).message);
      setDirectState("error");
    }
  }, [directToken, vpsUrl, cleanup]);

  const cancelSession = async () => {
    const id = sessionIdRef.current;
    if (id) {
      try {
        await fetch(`${vpsUrl}/_auth/bridge/agents/auth/${id}/cancel`, {
          method: "POST",
          credentials: "include",
        });
      } catch {}
    }
    cleanup();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) cancelSession(); }}>
      <DialogContent className="max-w-xl p-0 flex flex-col gap-0">
        <DialogHeader className="p-6">
          <DialogTitle className="flex items-center gap-2 text-base">Sign in to {label}</DialogTitle>
          <DialogDescription>
            {success
              ? `${label} is now connected.`
              : tool === "cursor"
                ? "Open the link below to sign in with your Cursor account."
                : "Follow the steps below to authenticate."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 px-6 pb-6">
          {authUrl ? (
            <div className="space-y-4">
              <div className="space-y-2">
                {tool !== "cursor" && <SignInStepHeader n={1} text="Open link in your browser" />}
                <div className="flex items-stretch gap-2">
                  <a
                    href={authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex flex-1 items-center gap-2 rounded-md border border-cream/[0.08] bg-cream/[0.03] min-w-0 px-3 py-2 text-sm text-cream hover:border-sodium/40 hover:bg-cream/[0.05] transition-colors"
                  >
                    <ExternalLink className="h-4 w-4 shrink-0 text-cream/40 group-hover:text-sodium" />
                    <span className="flex-1 truncate font-medium">{authUrl}</span>
                  </a>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="shrink-0 border-cream/[0.08]"
                    onClick={() => handleCopy(authUrl)}
                  >
                    {copyState === "copied"
                      ? <><Check className="h-3 w-3 mr-1" /> Copied</>
                      : <><Copy className="h-3 w-3 mr-1" /> Copy</>}
                  </Button>
                </div>
              </div>

              {tool !== "cursor" && (
                <div className="space-y-2">
                  <SignInStepHeader n={2} text={deviceCode ? "Enter this code" : "Paste the code"} />
                  {deviceCode ? (
                    <div className="flex items-center gap-2 rounded-md border border-cream/[0.08] bg-cream/[0.04] px-3 py-2">
                      <span className="flex-1 font-mono text-lg font-semibold tracking-[0.15em] text-cream">{deviceCode}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="shrink-0 text-cream/60"
                        onClick={() => handleCopy(deviceCode)}
                      >
                        {copyState === "copied"
                          ? <><Check className="h-3 w-3 mr-1" /> Copied</>
                          : <><Copy className="h-3 w-3 mr-1" /> Copy</>}
                      </Button>
                    </div>
                  ) : (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={(e) => { e.preventDefault(); sendInput(); }}
                    >
                      <input
                        type="text"
                        autoFocus
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        placeholder="Paste code here..."
                        disabled={!running}
                        className="flex-1 rounded-md border border-cream/[0.08] bg-cream/[0.03] px-3 py-2 text-sm font-mono text-cream placeholder:text-cream/30 focus:border-sodium/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                      />
                      <Button
                        type="submit"
                        size="sm"
                        disabled={!running || !inputValue.trim() || sendState === "sending"}
                        className="bg-sodium hover:bg-sodium/90"
                      >
                        {sendState === "sending" ? "Sending..." : sendState === "sent" ? "Sent" : "Send"}
                      </Button>
                    </form>
                  )}
                </div>
              )}
            </div>
          ) : running ? (
            <div className="flex items-center gap-2 rounded-md border border-dashed border-cream/[0.08] bg-cream/[0.02] px-3 py-6 text-sm text-cream/50">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Contacting {label}...</span>
            </div>
          ) : null}

          {tool === "claude" && (
            <details className="rounded-md border border-cream/[0.08] bg-cream/[0.02]">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs text-cream/50 hover:text-cream/70">
                Already have a token? Paste it directly
              </summary>
              <div className="space-y-2 px-3 pb-3 pt-2">
                <p className="text-xs text-cream/40">
                  Run <code className="rounded bg-cream/[0.06] px-1 py-0.5 font-mono text-[10px]">claude setup-token</code> on
                  any machine, copy the <code className="rounded bg-cream/[0.06] px-1 py-0.5 font-mono text-[10px]">sk-ant-oat01-...</code> token.
                </p>
                <textarea
                  value={directToken}
                  onChange={(e) => { setDirectToken(e.target.value); if (directState === "error") { setDirectState("idle"); setDirectError(null); } }}
                  placeholder="sk-ant-oat01-..."
                  className="w-full rounded-md border border-cream/[0.08] bg-cream/[0.03] px-3 py-2 text-xs font-mono text-cream placeholder:text-cream/30 focus:border-sodium/50 focus:outline-none"
                  rows={3}
                />
                {directError && <p className="text-xs text-terra">{directError}</p>}
                <Button
                  size="sm"
                  disabled={directState === "submitting" || !directToken.trim()}
                  onClick={submitDirectToken}
                  className="bg-sodium hover:bg-sodium/90"
                >
                  {directState === "submitting" ? "Saving..." : "Save token"}
                </Button>
              </div>
            </details>
          )}

          <details className="group rounded-md border border-cream/[0.08] bg-cream/[0.02]">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs text-cream/40 hover:text-cream/60 group-open:border-b group-open:border-cream/[0.06]">
              CLI transcript
            </summary>
            <pre
              ref={transcriptRef}
              className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-5 text-cream/60"
            >
              {cleanOutput || "Starting..."}
            </pre>
          </details>

          <div className="flex items-center justify-between gap-2 border-t border-cream/[0.06] pt-4 text-xs">
            <span className="flex items-center gap-2 min-w-0">
              {success ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
              ) : failed ? (
                <XCircle className="h-3.5 w-3.5 shrink-0 text-terra" />
              ) : (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-cream/50" />
              )}
              <span className="text-cream/50 truncate">
                {success
                  ? "Connected"
                  : error
                    ? error
                    : exitCode !== null
                      ? `Sign-in failed (exit ${exitCode})`
                      : authUrl
                        ? "Waiting for sign-in..."
                        : "Starting CLI..."}
              </span>
            </span>
            <div className="flex gap-2 shrink-0">
              {failed && (
                <Button size="sm" variant="outline" className="border-cream/[0.08]" onClick={startSession}>
                  Try again
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-cream/60"
                onClick={() => { if (success) onClose(); else cancelSession(); }}
              >
                {success ? "Done" : "Cancel"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SignInStepHeader({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-cream/50">
      {n > 0 && (
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cream/[0.06] font-mono text-[11px] text-cream">
          {n}
        </span>
      )}
      <span>{text}</span>
    </div>
  );
}
