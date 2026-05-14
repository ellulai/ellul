import { ImageResponse } from "next/og";
import { LOCALE_DISPLAY, type Locale } from "@ellul.ai/i18n-consts";

/**
 * Shared OG image template for the docs surface. Same layout as the web
 * template, with the eyebrow defaulting to "Docs" and a slightly different
 * subtitle slot for section context.
 */
export interface OgInput {
  title: string;
  highlight?: string;
  eyebrow?: string;
  subtitle?: string;
  locale?: Locale;
}

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

export function ogImageResponse(input: OgInput): ImageResponse {
  const {
    title,
    highlight,
    eyebrow = "Ellul Docs",
    subtitle = "Documentation for the always-on agent workstation.",
    locale = "en",
  } = input;

  const flag = LOCALE_DISPLAY[locale]?.flag ?? "";
  const totalChars = title.length + (highlight?.length ?? 0);
  const titleFontSize =
    totalChars > 80 ? 56 : totalChars > 50 ? 72 : totalChars > 30 ? 88 : 104;

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#0B0B0F",
          backgroundImage:
            "radial-gradient(ellipse at top, rgba(240,166,90,0.18), transparent 60%)",
          padding: "80px",
          justifyContent: "space-between",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <div
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "12px",
                background: "#F0A65A",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#0B0B0F",
                fontSize: "28px",
                fontWeight: 700,
                fontFamily: "JetBrains Mono, monospace",
              }}
            >
              e
            </div>
            <div
              style={{
                fontSize: "32px",
                color: "#F5EFE6",
                fontWeight: 300,
                letterSpacing: "-0.03em",
              }}
            >
              ellul docs
            </div>
          </div>
          {flag && (
            <div style={{ fontSize: "44px", lineHeight: 1, opacity: 0.85 }}>
              {flag}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: "32px",
              color: "rgba(240, 166, 90, 0.85)",
              fontFamily: "JetBrains Mono, monospace",
              textTransform: "uppercase",
              letterSpacing: "0.18em",
              marginBottom: "24px",
            }}
          >
            {eyebrow}
          </div>
          <div
            style={{
              fontSize: titleFontSize,
              color: "#F5EFE6",
              fontWeight: 200,
              letterSpacing: "-0.04em",
              lineHeight: 1.05,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <span>{title}</span>
            {highlight && <span style={{ color: "#F0A65A" }}>{highlight}</span>}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
          }}
        >
          <div
            style={{
              fontSize: "24px",
              color: "rgba(245, 239, 230, 0.55)",
              maxWidth: "780px",
              lineHeight: 1.4,
            }}
          >
            {subtitle}
          </div>
          <div
            style={{
              fontSize: "20px",
              color: "rgba(245, 239, 230, 0.4)",
              fontFamily: "JetBrains Mono, monospace",
            }}
          >
            ellul
          </div>
        </div>
      </div>
    ),
    { ...OG_SIZE },
  );
}
