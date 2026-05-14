// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useRef, memo } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Check,
  Eye,
  EyeOff,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  QrCode,
  X,
  RefreshCw,
} from "lucide-react";
import { useClawChannels, type ChannelConfig } from "@/hooks/useClawChannels";
import { getCodeApiUrl } from "@/lib/domains";
import { useCodeToken } from "@/contexts/CodeTokenContext";

interface ClawChannelsProps {
  serverDomain: string;
  project?: string | null;
}

interface ChannelDef {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  docsUrl: string;
  fields: ChannelField[];
}

interface ChannelField {
  key: string;
  label: string;
  placeholder: string;
  type: "text" | "password";
  help?: string;
}

const WhatsAppIcon = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="#25D366">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
  </svg>
);

const TelegramIcon = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="#26A5E4">
    <path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
  </svg>
);

const DiscordIcon = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="#5865F2">
    <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z" />
  </svg>
);

const SlackIcon = () => (
  <svg viewBox="0 0 24 24" className="h-5 w-5">
    <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z" fill="#36C5F0" />
    <path d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" fill="#2EB67D" />
    <path d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z" fill="#ECB22E" />
    <path d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="#E01E5A" />
  </svg>
);

function useChannels(): ChannelDef[] {
  const t = useTranslations("console.clawChannels");
  return [
    // WhatsApp requires custom zeroclaw build with --features whatsapp-web (not in release binary)
    {
      id: "telegram",
      name: t("telegramName"),
      description: t("telegramDescription"),
      icon: <TelegramIcon />,
      docsUrl: "https://docs.zeroclaw.org/channels/telegram",
      fields: [
        {
          key: "botToken",
          label: t("telegramBotTokenLabel"),
          placeholder: "123456:ABC-DEF1234...",
          type: "password",
          help: t("telegramBotTokenHelp"),
        },
      ],
    },
    {
      id: "discord",
      name: t("discordName"),
      description: t("discordDescription"),
      icon: <DiscordIcon />,
      docsUrl: "https://docs.zeroclaw.org/channels/discord",
      fields: [
        {
          key: "token",
          label: t("discordTokenLabel"),
          placeholder: t("discordTokenPlaceholder"),
          type: "password",
          help: t("discordTokenHelp"),
        },
      ],
    },
    // Slack requires testing with zeroclaw v0.6.2 — re-enable after verification
  ];
}

const EMPTY_CONFIG: ChannelConfig = Object.freeze({});

function WhatsAppPairing({
  serverDomain,
  project,
  onConnected,
}: {
  serverDomain: string;
  project?: string | null;
  onConnected?: () => void;
}) {
  const t = useTranslations("console.clawChannels");
  const codeApiUrl = getCodeApiUrl(serverDomain);
  const [started, setStarted] = useState(false);
  const [connected, setConnected] = useState(false);
  const iframeKey = useRef(0);

  const qs = project ? `&project=${encodeURIComponent(project)}` : "";
  const qrUrl = `${codeApiUrl}/api/zeroclaw/channels/whatsapp/qr?_t=${iframeKey.current}${qs}`;

  // Listen for postMessage from the iframe when WhatsApp connects
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "whatsapp-connected") {
        setConnected(true);
        onConnected?.();
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  if (connected) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-sodium/10 border border-sodium/20 px-3 py-2">
        <Check className="h-4 w-4 text-sodium" />
        <span className="text-sm text-sodium">{t("whatsappConnected")}</span>
      </div>
    );
  }

  if (!started) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-cream/60">
          {t("whatsappPairingHint")}
        </p>
        <Button
          size="sm"
          onClick={() => setStarted(true)}
          className="bg-[#25D366] hover:bg-[#20BD5A] text-cream h-8"
        >
          <QrCode className="h-3.5 w-3.5 mr-1.5" />
          {t("startPairing")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <iframe
        src={qrUrl}
        className="w-full border-0 rounded-lg"
        style={{ height: 320, background: "#0a0a0a" }}
        allow="clipboard-read; clipboard-write"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => { iframeKey.current++; setStarted(false); setTimeout(() => setStarted(true), 50); }}
          className="h-7 border-cream/[0.08] text-xs"
        >
          <RefreshCw className="h-3 w-3 mr-1" />
          {t("retry")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setStarted(false)}
          className="h-7 border-cream/[0.08] text-xs"
        >
          <X className="h-3 w-3 mr-1" />
          {t("cancel")}
        </Button>
      </div>
    </div>
  );
}

const ChannelCard = memo(function ChannelCard({
  channel,
  config,
  onSave,
  isSaving,
  serverDomain,
  project,
}: {
  channel: ChannelDef;
  config: ChannelConfig;
  onSave: (channel: string, config: ChannelConfig) => Promise<boolean>;
  isSaving: boolean;
  serverDomain: string;
  project?: string | null;
}) {
  const t = useTranslations("console.clawChannels");
  const [expanded, setExpanded] = useState(false);
  const [showFields, setShowFields] = useState<Record<string, boolean>>({});

  // Initialize form from server config; only re-sync when server values genuinely change.
  const [formValues, setFormValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of channel.fields) {
      initial[f.key] = (config[f.key] as string) || "";
    }
    return initial;
  });

  const configKey = JSON.stringify(channel.fields.map((f) => config[f.key] ?? ""));
  const prevConfigKeyRef = useRef(configKey);

  // Only reset form when server-side values actually change (e.g. after save),
  useEffect(() => {
    if (configKey === prevConfigKeyRef.current) return;
    prevConfigKeyRef.current = configKey;
    const initial: Record<string, string> = {};
    for (const f of channel.fields) {
      initial[f.key] = (config[f.key] as string) || "";
    }
    setFormValues(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  const isConfigured =
    config.enabled === true || channel.fields.some((f) => config[f.key]);
  const hasFields = channel.fields.length > 0;

  const handleSave = async () => {
    const newConfig: ChannelConfig = { enabled: true };
    for (const f of channel.fields) {
      if (formValues[f.key]?.trim()) {
        newConfig[f.key] = formValues[f.key]?.trim();
      }
    }
    const ok = await onSave(channel.id, newConfig);
    if (ok) setExpanded(false);
  };

  return (
    <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-cream/[0.02] transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-6 w-6 items-center justify-center shrink-0">{channel.icon}</div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-cream">
                {channel.name}
              </span>
              {isConfigured ? (
                <span className="flex items-center gap-1 rounded-full border border-sodium/30 bg-sodium/10 px-2 py-0.5 text-[10px] text-sodium">
                  <Check className="h-2.5 w-2.5" />
                  {t("connected")}
                </span>
              ) : (
                <span className="rounded-full border border-cream/[0.08] bg-cream/[0.03] px-2 py-0.5 text-[10px] text-cream/45">
                  {t("notConfigured")}
                </span>
              )}
            </div>
            <p className="text-xs text-cream/60 mt-0.5">
              {channel.description}
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-cream/60" />
        ) : (
          <ChevronDown className="h-4 w-4 text-cream/60" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-cream/[0.06] p-4 space-y-3">
          {/* WhatsApp special case — QR pairing */}
          {channel.id === "whatsapp" && (
            <WhatsAppPairing serverDomain={serverDomain} project={project} onConnected={() => onSave("whatsapp", { enabled: true })} />
          )}

          {/* Token-based channels */}
          {hasFields && (
            <div className="space-y-3">
              {channel.fields.map((field) => (
                <div key={field.key}>
                  <label className="block text-xs font-medium text-cream/75 mb-1">
                    {field.label}
                  </label>
                  <div className="relative">
                    <input
                      type={showFields[field.key] ? "text" : field.type}
                      value={formValues[field.key] || ""}
                      onChange={(e) =>
                        setFormValues((prev) => ({
                          ...prev,
                          [field.key]: e.target.value,
                        }))
                      }
                      placeholder={field.placeholder}
                      className="w-full rounded-md border border-cream/[0.08] bg-cream/[0.03] px-3 py-2 pr-9 text-sm text-cream placeholder:text-cream/45 focus:border-sodium/50 focus:outline-none"
                    />
                    {field.type === "password" && (
                      <button
                        type="button"
                        onClick={() =>
                          setShowFields((prev) => ({
                            ...prev,
                            [field.key]: !prev[field.key],
                          }))
                        }
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-cream/45 hover:text-cream transition-colors"
                      >
                        {showFields[field.key] ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}
                  </div>
                  {field.help && (
                    <p className="text-[10px] text-cream/45 mt-1">
                      {field.help}
                    </p>
                  )}
                </div>
              ))}

              <div className="flex items-center gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="bg-sodium hover:bg-sodium h-8"
                >
                  {isSaving ? <Spinner size="sm" delay={300} /> : t("save")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setExpanded(false)}
                  className="h-8 border-cream/[0.08]"
                >
                  {t("cancel")}
                </Button>
              </div>
            </div>
          )}

          {/* Docs link */}
          <a
            href={channel.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-sodium hover:text-sodium transition-colors"
          >
            {t("viewSetupGuide")}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
    </div>
  );
});

export const ClawChannels = memo(function ClawChannels({ serverDomain, project }: ClawChannelsProps) {
  const t = useTranslations("console.clawChannels");
  const channelsList = useChannels();
  const { channels, isLoading, isSaving, error, fetchChannels, saveChannel } =
    useClawChannels(serverDomain, project);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner delay={300} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-medium text-cream mb-1">{t("title")}</h2>
        <p className="text-sm text-cream/60">
          {t("subtitleConsole")}
        </p>
      </div>

      {error && <p className="text-xs text-terra">{error}</p>}

      <div className="space-y-2">
        {channelsList.map((ch) => (
          <ChannelCard
            key={ch.id}
            channel={ch}
            config={(channels[ch.id] as ChannelConfig) || EMPTY_CONFIG}
            onSave={saveChannel}
            isSaving={isSaving}
            serverDomain={serverDomain}
            project={project}
          />
        ))}
      </div>
    </div>
  );
});
