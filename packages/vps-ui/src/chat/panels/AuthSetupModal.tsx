// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// In-chat auth flow: spawns the provider's CLI login command (claude
// setup-token / codex login --device-auth / cursor-agent login) in a
// PTY on the server, streams its output over SSE, and lets the user
// type responses directly into the dialog. When the process exits 0,
// the caller is notified so the ProviderStatusBanner can refresh.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  Loader2Icon,
  XCircleIcon,
} from "lucide-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProvider,
} from "@ellul.ai/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { useTranslations } from "use-intl";
import { Button } from "../ui/button";
import { cn } from "@shared/utils";

const AUTH_TOOL_BY_PROVIDER: Record<ProviderKind, "claude" | "codex" | "cursor" | null> = {
  claudeAgent: "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: null,
  zeroclaw: null,
  grokAgent: null,
};

export interface AuthSetupModalProps {
  readonly open: boolean;
  readonly status: ServerProvider | null;
  readonly onClose: () => void;
  readonly onSuccess: (provider: ProviderKind) => void | Promise<void>;
}

type SessionState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running"; sessionId: string }
  | { kind: "completed"; exitCode: number }
  | { kind: "error"; message: string };

// ANSI renderer for Ink-style TUI output. Ported from the pre-t3
// interactive.service.ts. Claude's CLI prints the OAuth URL wrapped at
// terminal-width — a naive strip leaves a mangled URL. We translate
// ESC[NC → N spaces and ESC[NB → N newlines so layout is preserved,
// then reassemble wrapped URLs: if a bare-URL-characters line follows
// a line ending with "https://..." (and the first line doesn't end in
// whitespace), glue them.
const ANSI_CURSOR_FORWARD = /\x1B\[(\d*)C/g;
const ANSI_CURSOR_DOWN = /\x1B\[(\d*)B/g;
const ANSI_CSI = /\x1B\[[0-9;?]*[a-zA-Z]/g;
const ANSI_OSC = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
const ANSI_TWOBYTE = /\x1B[()][AB012]/g;
const ANSI_SINGLE = /\x1B[=>NOM78HcDZ<]/g;
const ANSI_PRIVATE = /\x1B\[\?[0-9;]*[hl]/g;
const CONTROL_CHARS = /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g;

function stripAnsi(input: string): string {
  const stripped = input
    .replace(ANSI_CURSOR_FORWARD, (_, n: string) =>
      " ".repeat(n ? Math.min(parseInt(n, 10), 200) : 1),
    )
    .replace(ANSI_CURSOR_DOWN, (_, n: string) => "\n".repeat(n ? parseInt(n, 10) || 1 : 1))
    .replace(ANSI_PRIVATE, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_OSC, "")
    .replace(ANSI_TWOBYTE, "")
    .replace(ANSI_SINGLE, "")
    .replace(CONTROL_CHARS, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const lines = stripped.split("\n");
  const out: string[] = [];
  const URL_CONTINUATION = /^[a-zA-Z0-9%&=_.~:/?#[\]@!$'()+,;-]+$/;
  for (const raw of lines) {
    const line = raw;
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    // Continuation rule: trimmed line is URL chars, prev (non-empty) line ends
    // with `https://...` and no trailing whitespace. The "no leading
    // whitespace" check the previous version had broke whenever Claude Code's
    // banner art positioned the wrapped URL in an indented column — Ink's
    // cursor moves get translated to spaces by stripAnsi above, so the
    // continuation arrives with leading whitespace even though the original
    // PTY emitted a single logical URL line. Keep the regex tight (still URL
    // chars only) but drop the no-leading-space gate.
    const trimmed = line.trim();
    if (URL_CONTINUATION.test(trimmed)) {
      let prevIdx = out.length - 1;
      while (prevIdx >= 0 && out[prevIdx]!.trim() === "") prevIdx -= 1;
      if (prevIdx >= 0) {
        const prev = out[prevIdx]!;
        const prevTrimmed = prev.trimEnd();
        if (
          /https?:\/\//.test(prev) &&
          // Prev line's URL must extend to (or close to) its rightmost char —
          // if there's a long run of trailing spaces it's probably banner art
          // padding rather than a wrapped URL. Check by stripping spaces and
          // confirming the URL is the LAST token on that line.
          /https?:\/\/[^\s]*$/.test(prevTrimmed)
        ) {
          out[prevIdx] = prevTrimmed + trimmed;
          continue;
        }
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

// Match the URL strictly — `[^\s"'`<>]+` accidentally includes the closing
// braces of any TUI box-drawing that surrounds the URL. Keep it to URL chars.
const URL_RE = /https?:\/\/[a-zA-Z0-9%&=_.~:/?#[\]@!$'()+,;*-]+/g;

function extractAuthUrl(output: string): string | null {
  // Pick the LONGEST `https://...` substring — Claude Code prints the OAuth
  // URL on one logical line, and after the wrap-rejoin pass above it is the
  // longest of any URL in the output. Anthropic may sneak shorter status URLs
  // (`https://claude.ai/`, `https://docs.anthropic.com`) into preamble or
  // troubleshooting copy; those are always shorter than the OAuth URL with its
  // ~5 query params.
  const matches = output.match(URL_RE);
  if (!matches || matches.length === 0) return null;
  let best = matches[0]!;
  for (const m of matches) {
    if (m.length > best.length) best = m;
  }
  return best;
}

// codex + gh device flow print a 4-5 / 4-5 char code (`0F77-6JLN6`).
// Narrow match so version strings and hashes don't false-positive.
function extractDeviceCode(output: string): string | null {
  const match = output.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/);
  return match ? match[0] : null;
}

function isAwaitingCodePaste(output: string): boolean {
  return /paste\s+code\s+here/i.test(output);
}

export const AuthSetupModal = memo(function AuthSetupModal({
  open,
  status,
  onClose,
  onSuccess,
}: AuthSetupModalProps) {
  const tChat = useTranslations("chat");
  const [session, setSession] = useState<SessionState>({ kind: "idle" });
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [directToken, setDirectToken] = useState("");
  const [directState, setDirectState] = useState<"idle" | "submitting" | "error">("idle");
  const [directError, setDirectError] = useState<string | null>(null);
  const [directOpen, setDirectOpen] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const transcriptOpenRef = useRef<boolean>(false);

  const provider = status?.provider ?? null;
  const tool = provider ? AUTH_TOOL_BY_PROVIDER[provider] : null;
  const displayName = provider ? (PROVIDER_DISPLAY_NAMES[provider] ?? provider) : tChat("authSetup.fallbackProvider");

  const cleanOutput = useMemo(() => stripAnsi(output), [output]);
  const authUrl = useMemo(() => extractAuthUrl(cleanOutput), [cleanOutput]);
  const deviceCode = useMemo(() => extractDeviceCode(cleanOutput), [cleanOutput]);
  const awaitingPaste = useMemo(
    () => isAwaitingCodePaste(cleanOutput),
    [cleanOutput],
  );

  const closeSession = useCallback(async (reason: "cancel" | "success" | "error") => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    const id = sessionIdRef.current;
    sessionIdRef.current = null;
    if (id && reason !== "success") {
      await fetch(`/_auth/bridge/agents/auth/${id}/cancel`, {
        method: "POST",
        credentials: "include",
      }).catch(() => undefined);
    }
  }, []);

  const startSession = useCallback(async () => {
    if (!tool || !provider) return;
    setSession({ kind: "starting" });
    setOutput("");
    setInput("");
    setSendState("idle");
    try {
      const res = await fetch("/_auth/bridge/agents/auth/start", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `Failed to start session (${res.status})`);
      }
      const { sessionId } = (await res.json()) as { sessionId: string };
      sessionIdRef.current = sessionId;
      setSession({ kind: "running", sessionId });

      const events = new EventSource(
        `/_auth/bridge/agents/auth/${sessionId}/events`,
        { withCredentials: true },
      );
      eventSourceRef.current = events;
      events.onmessage = (ev) => {
        let parsed: { type: string; chunk?: string; exitCode?: number; message?: string };
        try {
          parsed = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (parsed.type === "data" && typeof parsed.chunk === "string") {
          setOutput((prev) => (prev + parsed.chunk!).slice(-128_000));
        } else if (parsed.type === "exit") {
          const code = parsed.exitCode ?? -1;
          setSession({ kind: "completed", exitCode: code });
          eventSourceRef.current?.close();
          eventSourceRef.current = null;
          if (code === 0 && provider) {
            void Promise.resolve(onSuccess(provider));
          }
        } else if (parsed.type === "error" && typeof parsed.message === "string") {
          setSession({ kind: "error", message: parsed.message });
        }
      };
      events.onerror = () => {
        // EventSource retries automatically; ignore transient errors.
      };
    } catch (err) {
      setSession({ kind: "error", message: (err as Error).message });
    }
  }, [onSuccess, provider, tool]);

  useEffect(() => {
    if (!open) {
      void closeSession("cancel");
      setSession({ kind: "idle" });
      setOutput("");
      setInput("");
      setSendState("idle");
      setDirectToken("");
      setDirectState("idle");
      setDirectError(null);
      setDirectOpen(false);
      transcriptOpenRef.current = false;
      return;
    }
    if (session.kind === "idle" && tool) void startSession();
    // Intentional: only run on open/tool change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tool]);

  useEffect(() => {
    const el = outputRef.current;
    if (el && transcriptOpenRef.current) el.scrollTop = el.scrollHeight;
  }, [cleanOutput]);

  const sendInput = useCallback(async (payload: string) => {
    const id = sessionIdRef.current;
    if (!id) return false;
    try {
      const res = await fetch(`/_auth/bridge/agents/auth/${id}/input`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: payload }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  const handleSubmitInput = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setSendState("sending");
    // Server handles the CR commit with a 200ms delay (Ink needs time
    // to consume the typed chars before Enter arrives). We send the
    // code only; the backend writes "<code>" then "\r" after a pause.
    const ok = await sendInput(trimmed);
    if (ok) {
      setInput("");
      setSendState("sent");
      setTimeout(() => setSendState((s) => (s === "sent" ? "idle" : s)), 1500);
    } else {
      setSendState("failed");
      setTimeout(() => setSendState((s) => (s === "failed" ? "idle" : s)), 2000);
    }
  }, [input, sendInput]);

  const handleSubmitDirectToken = useCallback(async () => {
    const trimmed = directToken.trim();
    if (!trimmed.startsWith("sk-ant-oat01-")) {
      setDirectError(tChat("authSetup.directTokenInvalid"));
      setDirectState("error");
      return;
    }
    setDirectState("submitting");
    setDirectError(null);
    try {
      const res = await fetch("/_auth/bridge/agents/auth/claude-token", {
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
      void closeSession("success");
      setDirectToken("");
      setDirectState("idle");
      setSession({ kind: "completed", exitCode: 0 });
      if (provider) void Promise.resolve(onSuccess(provider));
    } catch (e) {
      setDirectError((e as Error).message);
      setDirectState("error");
    }
  }, [closeSession, directToken, onSuccess, provider]);

  const handleCopyCode = useCallback(async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      // Fallback: select-all in a hidden textarea
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopyState("copied");
        setTimeout(() => setCopyState("idle"), 1800);
      } catch {
        // give up silently — user can still select text manually
      }
      document.body.removeChild(ta);
    }
  }, []);

  const success = session.kind === "completed" && session.exitCode === 0;
  const failed =
    (session.kind === "completed" && session.exitCode !== 0) || session.kind === "error";
  const inputEnabled =
    session.kind === "running" || session.kind === "starting";

  const statusLine =
    session.kind === "starting"
      ? { icon: "spin" as const, text: tChat("authSetup.status.starting") }
      : session.kind === "running"
        ? authUrl
          ? awaitingPaste
            ? { icon: "spin" as const, text: tChat("authSetup.status.waitingPaste") }
            : { icon: "spin" as const, text: tChat("authSetup.status.urlReady") }
          : { icon: "spin" as const, text: tChat("authSetup.status.startingCli") }
        : success
          ? { icon: "check" as const, text: tChat("authSetup.status.connected") }
          : failed
            ? {
                icon: "x" as const,
                text:
                  session.kind === "error"
                    ? tChat("authSetup.status.errorPrefix", { message: session.message })
                    : tChat("authSetup.status.signinFailed", {
                        exitCode: (session as { exitCode: number }).exitCode,
                      }),
              }
            : { icon: "spin" as const, text: tChat("authSetup.status.idle") };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          void closeSession("cancel");
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            {tChat("authSetup.title", { provider: displayName })}
          </DialogTitle>
          <DialogDescription>
            {tool === "cursor"
              ? tChat("authSetup.descriptionCursor")
              : tChat("authSetup.descriptionDefault")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 px-6 pb-6">

        {authUrl ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <StepHeader
                n={tool === "cursor" ? 0 : 1}
                text={
                  tool === "cursor"
                    ? tChat("authSetup.openLinkSignIn")
                    : tChat("authSetup.openLinkBrowser")
                }
              />
              <div className="flex items-stretch gap-2">
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "group flex flex-1 items-center gap-2 rounded-md border border-border bg-card",
                    "min-w-0 px-3 py-2 text-sm text-foreground hover:border-primary/60 hover:bg-accent",
                  )}
                >
                  <ExternalLinkIcon className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                  <span className="flex-1 truncate font-medium">{authUrl}</span>
                </a>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void handleCopyCode(authUrl)}
                  aria-label={tChat("authSetup.copyUrl")}
                  title={tChat("authSetup.copyFullUrl")}
                >
                  {copyState === "copied" ? (
                    <>
                      <CheckIcon />
                      {tChat("authSetup.copied")}
                    </>
                  ) : (
                    <>
                      <CopyIcon />
                      {tChat("authSetup.copy")}
                    </>
                  )}
                </Button>
              </div>
            </div>

            {tool === "cursor" ? null : (
            <div className="space-y-2">
              <StepHeader
                n={2}
                text={deviceCode ? tChat("authSetup.enterCode") : tChat("authSetup.pasteCode")}
              />
              {deviceCode ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/60 px-3 py-2">
                  <span className="flex-1 font-mono text-lg font-semibold tracking-[0.15em]">
                    {deviceCode}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => void handleCopyCode(deviceCode)}
                  >
                    {copyState === "copied" ? (
                      <>
                        <CheckIcon />
                        {tChat("authSetup.copied")}
                      </>
                    ) : (
                      <>
                        <CopyIcon />
                        {tChat("authSetup.copy")}
                      </>
                    )}
                  </Button>
                </div>
              ) : (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleSubmitInput();
                  }}
                >
                  <input
                    type="text"
                    autoFocus
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleSubmitInput();
                      }
                    }}
                    placeholder={tChat("authSetup.pastePlaceholder")}
                    disabled={!inputEnabled}
                    className={cn(
                      "flex-1 rounded-md border border-border bg-input px-3 py-2 text-sm",
                      "font-mono text-foreground placeholder:text-muted-foreground/60",
                      "disabled:cursor-not-allowed disabled:opacity-60",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!inputEnabled || input.trim().length === 0 || sendState === "sending"}
                  >
                    {sendState === "sending"
                      ? tChat("authSetup.sending")
                      : sendState === "sent"
                        ? tChat("authSetup.sent")
                        : sendState === "failed"
                          ? tChat("authSetup.retry")
                          : tChat("authSetup.send")}
                  </Button>
                </form>
              )}
              {sendState === "failed" ? (
                <p className="text-xs text-destructive">{tChat("composer.sendFailed")}</p>
              ) : null}
            </div>
            )}
          </div>
        ) : session.kind === "starting" || session.kind === "running" ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-6 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" />
            <span>{tChat("authSetup.contacting")}</span>
          </div>
        ) : null}

        {tool === "claude" ? (
          <details
            open={directOpen}
            onToggle={(e) => setDirectOpen((e.currentTarget as HTMLDetailsElement).open)}
            className="rounded-md border border-border bg-muted/20"
          >
            <summary className="cursor-pointer select-none px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
              {tChat("authSetup.directTokenSummary")}
            </summary>
            <div className="space-y-2 px-3 pb-3 pt-2">
              <p className="text-xs text-muted-foreground">
                {tChat.rich("authSetup.directTokenHelp", {
                  code: (chunks) => (
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">{chunks}</code>
                  ),
                })}
              </p>
              <textarea
                value={directToken}
                onChange={(e) => {
                  setDirectToken(e.target.value);
                  if (directState === "error") {
                    setDirectState("idle");
                    setDirectError(null);
                  }
                }}
                placeholder={tChat("authSetup.tokenPlaceholder")}
                className={cn(
                  "w-full rounded-md border border-border bg-input px-3 py-2 text-xs",
                  "font-mono text-foreground placeholder:text-muted-foreground/60",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
                rows={3}
              />
              {directError ? (
                <p className="text-xs text-destructive">{directError}</p>
              ) : null}
              <Button
                type="button"
                size="sm"
                disabled={directState === "submitting" || directToken.trim().length === 0}
                onClick={() => void handleSubmitDirectToken()}
              >
                {directState === "submitting" ? tChat("authSetup.saving") : tChat("authSetup.saveToken")}
              </Button>
            </div>
          </details>
        ) : null}

        <details
          className="group rounded-md border border-border bg-muted/30"
          onToggle={(e) => {
            transcriptOpenRef.current = (e.currentTarget as HTMLDetailsElement).open;
          }}
        >
          <summary className="cursor-pointer select-none px-3 py-2 text-xs text-muted-foreground group-open:border-b group-open:border-border">
            {tChat("authSetup.transcriptHeader")}
          </summary>
          <pre
            ref={outputRef}
            className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-5 text-foreground/75"
          >
            {cleanOutput || tChat("authSetup.transcriptStarting")}
          </pre>
        </details>

        <div className="flex items-center justify-between gap-2 border-t border-border pt-4 text-xs">
          <span className="flex items-center gap-2">
            {statusLine.icon === "spin" ? (
              <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
            ) : statusLine.icon === "check" ? (
              <CheckIcon className="size-3.5 text-primary" />
            ) : (
              <XCircleIcon className="size-3.5 text-destructive" />
            )}
            <span className="text-muted-foreground">{statusLine.text}</span>
          </span>
          <div className="flex gap-2">
            {failed ? (
              <Button size="sm" variant="outline" onClick={() => void startSession()}>
                {tChat("authSetup.tryAgain")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void closeSession("cancel");
                onClose();
              }}
            >
              {success ? tChat("authSetup.close") : tChat("authSetup.cancel")}
            </Button>
          </div>
        </div>

        </div>
      </DialogContent>
    </Dialog>
  );
});

function StepHeader({ n, text }: { readonly n: number; readonly text: string }) {
  return (
    <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {n > 0 ? (
        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[11px] text-foreground">
          {n}
        </span>
      ) : null}
      <span>{text}</span>
    </div>
  );
}
