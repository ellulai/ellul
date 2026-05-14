import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', "Inter", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
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
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        "panel-lift": "0 4px 16px rgba(0,0,0,0.25)",
        neon: "0 0 24px -8px rgba(240, 166, 90, 0.15)",
        "neon-bright": "0 0 24px -8px rgba(240, 166, 90, 0.3)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
