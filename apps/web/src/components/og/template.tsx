import { ImageResponse } from "next/og";
import { LOCALE_DISPLAY, type Locale } from "@ellul.ai/i18n-consts";

/**
 * Shared OG image template. Used by every opengraph-image.tsx in the app
 * to keep all surface OGs visually identical; only title, eyebrow, locale
 * flag, and footer change.
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

// Locales whose glyphs aren't covered by the edge runtime's default font set.
// For these we fetch Noto Sans JP at request time so the OG image shows real
// Japanese characters instead of tofu boxes (□). Module-level cache amortizes
// across same-instance invocations on Vercel Edge.
const CJK_LOCALES = new Set<Locale>(["ja", "ko"]);
let notoSansJpCache: ArrayBuffer | null = null;

async function loadNotoSansJp(): Promise<ArrayBuffer | null> {
  if (notoSansJpCache) return notoSansJpCache;
  try {
    // satori (the engine behind next/og) only accepts TTF or OTF — woff2 is
    // rejected with `Unsupported OpenType signature wOF2`. Fontsource
    // publishes a TTF for every weight/subset; we pin the 500-weight japanese
    // subset which covers hiragana, katakana, and CJK Han. The TTF is ~5 MB
    // but cached at module scope after the first fetch on each Edge instance.
    // Fall back gracefully on any failure — the OG image still renders, just
    // with tofu boxes where JP glyphs would have appeared.
    const fontRes = await fetch(
      "https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-jp@5.0.5/files/noto-sans-jp-japanese-500-normal.ttf",
    );
    if (!fontRes.ok) return null;
    notoSansJpCache = await fontRes.arrayBuffer();
    return notoSansJpCache;
  } catch {
    return null;
  }
}

export async function ogImageResponse(input: OgInput): Promise<ImageResponse> {
  const { title, highlight, eyebrow, subtitle, locale = "en" } = input;

  const flag = LOCALE_DISPLAY[locale]?.flag ?? "";
  // Pick a font size based on combined title length so long titles stay
  // inside the card without manual line-breaking.
  const totalChars = title.length + (highlight?.length ?? 0);
  const titleFontSize =
    totalChars > 80 ? 64 : totalChars > 50 ? 80 : totalChars > 30 ? 96 : 108;

  const jpFont = CJK_LOCALES.has(locale) ? await loadNotoSansJp() : null;

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
          fontFamily: "Noto Sans JP, Inter, system-ui, sans-serif",
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
              ellul
            </div>
          </div>
          {flag && (
            <div
              style={{
                fontSize: "44px",
                lineHeight: 1,
                opacity: 0.85,
              }}
            >
              {flag}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          {eyebrow && (
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
          )}
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
            {highlight && (
              <span style={{ color: "#F0A65A" }}>{highlight}</span>
            )}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
          }}
        >
          {subtitle && (
            <div
              style={{
                fontSize: "26px",
                color: "rgba(245, 239, 230, 0.55)",
                maxWidth: "780px",
                lineHeight: 1.4,
              }}
            >
              {subtitle}
            </div>
          )}
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
    {
      ...OG_SIZE,
      ...(jpFont
        ? {
            fonts: [
              {
                name: "Noto Sans JP",
                data: jpFont,
                style: "normal",
                weight: 500,
              },
            ],
          }
        : {}),
    },
  );
}
