import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "JetBrains Mono", "ui-monospace", "monospace"],
        display: ["var(--font-inter)", "Inter", "system-ui", "sans-serif"],
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
        /* Legacy ascente tokens — remapped to new palette for cascading compatibility */
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
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      boxShadow: {
        "panel-lift": "0 4px 16px rgba(0,0,0,0.25)",
        neon: "0 0 24px -8px rgba(240, 166, 90, 0.15)",
        "neon-bright": "0 0 20px rgba(240, 166, 90, 0.2), 0 2px 8px rgba(0, 0, 0, 0.3)",
        dot: "0 0 6px rgba(240, 166, 90, 0.6)",
        "card-hover": "0 8px 32px -8px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(245, 239, 230, 0.08)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(10px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-out-down": {
          from: { opacity: "1", transform: "translateY(0)" },
          to: { opacity: "0", transform: "translateY(10px)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.95)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "scale-out": {
          from: { opacity: "1", transform: "scale(1)" },
          to: { opacity: "0", transform: "scale(0.95)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(20px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        "slide-out-left": {
          from: { opacity: "1", transform: "translateX(0)" },
          to: { opacity: "0", transform: "translateX(-20px)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in-up": "fade-in-up 0.2s ease-out",
        "fade-out-down": "fade-out-down 0.2s ease-out",
        "scale-in": "scale-in 0.2s ease-out",
        "scale-out": "scale-out 0.2s ease-out",
        "slide-in-right": "slide-in-right 0.2s ease-out",
        "slide-out-left": "slide-out-left 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
