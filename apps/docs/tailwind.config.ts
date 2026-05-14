import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: ["./src/**/*.{ts,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "var(--font-noto-sans-jp)", "var(--font-noto-sans-kr)", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "JetBrains Mono", "ui-monospace", "monospace"],
        display: ["var(--font-inter)", "var(--font-noto-sans-jp)", "var(--font-noto-sans-kr)", "Inter", "system-ui", "sans-serif"],
      },
      colors: {
        ink: {
          DEFAULT: "#0B0B0F",
          1: "#13131A",
          2: "#1A1A23",
        },
        sodium: {
          DEFAULT: "#F0A65A",
          soft: "rgba(240, 166, 90, 0.14)",
          strong: "#F4B873",
        },
        cream: {
          DEFAULT: "#F5EFE6",
        },
        terra: {
          DEFAULT: "#E5806B",
        },
        /* Legacy ascente — remapped */
        ascente: {
          yellow: "#F0A65A",
          "yellow-light": "#F4B873",
          orange: "#F0A65A",
          "orange-deep": "#E08F45",
          plum: "#13131A",
          "plum-light": "#1A1A23",
          "plum-surface": "#0B0B0F",
          "plum-border": "rgba(245, 239, 230, 0.12)",
          black: "#0B0B0F",
          seam: "transparent",
        },
        canvas: "#0B0B0F",
        surface: "#13131A",
        "surface-border": "rgba(245, 239, 230, 0.07)",
        foreground: "#F5EFE6",
        muted: "rgba(245, 239, 230, 0.6)",
      },
      boxShadow: {
        "panel-lift": "0 4px 16px rgba(0,0,0,0.25)",
        "glow-amber": "0 0 24px rgba(240, 166, 90, 0.15)",
        "glow-teal": "0 0 20px rgba(240, 166, 90, 0.15)",
        dot: "0 0 6px rgba(240, 166, 90, 0.6)",
      },
      typography: {
        ascente: {
          css: {
            "--tw-prose-body": "rgba(245, 239, 230, 0.7)",
            "--tw-prose-headings": "#F5EFE6",
            "--tw-prose-lead": "rgba(245, 239, 230, 0.85)",
            "--tw-prose-links": "#F0A65A",
            "--tw-prose-bold": "#F5EFE6",
            "--tw-prose-counters": "rgba(245, 239, 230, 0.55)",
            "--tw-prose-bullets": "rgba(240, 166, 90, 0.55)",
            "--tw-prose-hr": "rgba(245, 239, 230, 0.07)",
            "--tw-prose-quotes": "rgba(245, 239, 230, 0.85)",
            "--tw-prose-quote-borders": "#F0A65A",
            "--tw-prose-captions": "rgba(245, 239, 230, 0.45)",
            "--tw-prose-code": "#F0A65A",
            "--tw-prose-pre-code": "rgba(245, 239, 230, 0.85)",
            "--tw-prose-pre-bg": "#0B0B0F",
            "--tw-prose-th-borders": "rgba(245, 239, 230, 0.12)",
            "--tw-prose-td-borders": "rgba(245, 239, 230, 0.07)",
            color: "rgba(245, 239, 230, 0.7)",
            a: {
              color: "#F0A65A",
              textDecoration: "none",
              fontWeight: "500",
              "&:hover": {
                color: "#F4B873",
              },
            },
            strong: {
              color: "#F5EFE6",
            },
            code: {
              color: "#F0A65A",
              backgroundColor: "#0B0B0F",
              borderRadius: "0.25rem",
              padding: "0.15rem 0.4rem",
              fontWeight: "400",
              border: "1px solid rgba(245, 239, 230, 0.07)",
            },
            "code::before": {
              content: '""',
            },
            "code::after": {
              content: '""',
            },
            pre: {
              backgroundColor: "#0B0B0F",
              border: "1px solid rgba(245, 239, 230, 0.07)",
              borderRadius: "0.75rem",
            },
            h1: {
              color: "#F5EFE6",
              letterSpacing: "-0.04em",
            },
            h2: {
              color: "#F5EFE6",
              letterSpacing: "-0.04em",
            },
            h3: {
              color: "#F5EFE6",
              letterSpacing: "-0.03em",
            },
            h4: {
              color: "#F5EFE6",
            },
            blockquote: {
              color: "rgba(245, 239, 230, 0.85)",
              borderLeftColor: "#F0A65A",
            },
            hr: {
              borderColor: "rgba(245, 239, 230, 0.07)",
            },
            "thead th": {
              color: "#F5EFE6",
            },
            "tbody td": {
              color: "rgba(245, 239, 230, 0.7)",
            },
          },
        },
      },
    },
  },
  plugins: [typography],
};

export default config;
