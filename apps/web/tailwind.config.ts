import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
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
        ascente: {
          yellow: "#FFC107",
          "yellow-light": "#FFD740",
          orange: "#FFA000",
          "orange-deep": "#F57C00",
          plum: "#1A0030",
          "plum-light": "#2A0045",
          "plum-surface": "#0D0015",
          "plum-border": "#3D0066",
          black: "#000000",
          seam: "transparent",
        },
      },
      boxShadow: {
        "panel-lift": "0 4px 16px rgba(0,0,0,0.25)",
      },
      animation: {
        "fade-in-up": "fadeInUp 0.5s ease-out forwards",
      },
    },
  },
  plugins: [],
};

export default config;
