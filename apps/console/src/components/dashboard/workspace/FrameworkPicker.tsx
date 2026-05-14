// SPDX-License-Identifier: MIT
"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Check, ArrowRight } from "lucide-react";
import { FrameworkLogo } from "./FrameworkLogos";

// Curated framework catalog for the onboarding modal. IDs match the
export interface FrameworkOption {
  id: string;
  label: string;
  tagline: string;
  group: "frontend" | "backend" | "data" | "mobile";
}

// Full scaffoldable catalog. Every id matches `SCAFFOLDABLE_FRAMEWORK_IDS`
export const FRAMEWORK_OPTIONS: readonly FrameworkOption[] = [
  // ── Full-stack ────────────────────────────────────────────────────────
  { id: "next",        label: "Next.js",           tagline: "React · full-stack",         group: "frontend" },
  { id: "vite",        label: "Vite + React",      tagline: "Fast SPA with TypeScript",   group: "frontend" },
  { id: "nuxt",        label: "Nuxt",              tagline: "Vue · universal rendering",  group: "frontend" },
  { id: "astro",       label: "Astro",             tagline: "Content-first islands",      group: "frontend" },
  { id: "svelte",      label: "SvelteKit",         tagline: "Svelte · full-stack",        group: "frontend" },
  { id: "remix",       label: "Remix",             tagline: "Nested-routing React",       group: "frontend" },
  { id: "rails",       label: "Ruby on Rails",     tagline: "Ruby · full-stack MVC",      group: "frontend" },
  { id: "laravel",     label: "Laravel",           tagline: "PHP · full-stack MVC",       group: "frontend" },
  { id: "django",      label: "Django",            tagline: "Python · full-stack MVC",    group: "frontend" },
  { id: "phoenix",     label: "Phoenix",           tagline: "Elixir · real-time MVC",     group: "frontend" },
  // ── Backend / API ─────────────────────────────────────────────────────
  { id: "hono",        label: "Hono",              tagline: "Edge-ready API",             group: "backend"  },
  { id: "express",     label: "Express",           tagline: "Minimal Node server",        group: "backend"  },
  { id: "fastify",     label: "Fastify",           tagline: "Low-overhead plugins",       group: "backend"  },
  { id: "nestjs",      label: "NestJS",            tagline: "TypeScript server framework",group: "backend"  },
  { id: "fastapi",     label: "FastAPI",           tagline: "Type-safe Python API",       group: "backend"  },
  { id: "flask",       label: "Flask",             tagline: "Python microframework",      group: "backend"  },
  { id: "dotnet",      label: ".NET",              tagline: "ASP.NET Web API",            group: "backend"  },
  { id: "golang",      label: "Go",                tagline: "net/http server",            group: "backend"  },
  { id: "rust",        label: "Rust",              tagline: "cargo init console app",     group: "backend"  },
  { id: "spring-boot", label: "Spring Boot",       tagline: "Java · Maven build",         group: "backend"  },
  { id: "elixir",      label: "Elixir",            tagline: "Mix project starter",        group: "backend"  },
  // ── Data / ML ─────────────────────────────────────────────────────────
  { id: "streamlit",   label: "Streamlit",         tagline: "Data apps in Python",        group: "data"     },
  { id: "gradio",      label: "Gradio",            tagline: "ML demo interfaces",         group: "data"     },
  // ── Mobile ────────────────────────────────────────────────────────────
  { id: "flutter",     label: "Flutter",           tagline: "Cross-platform · web",       group: "mobile"   },
] as const;

export const MONOREPO_OPTIONS: readonly FrameworkOption[] = [
  { id: "turbo",       label: "Turborepo",         tagline: "Workspaces + task graph",    group: "frontend" },
] as const;

export const DEFAULT_FRAMEWORK_ID = "next";

type CategoryId = FrameworkOption["group"];

// IDs only — labels come from `console.frameworkPicker.categories.*` at render.
const CATEGORY_IDS: readonly CategoryId[] = [
  "frontend",
  "backend",
  "data",
  "mobile",
] as const;

// Studio quick picks. Two high-friction-cut cards that bypass the full
// catalog. Visual props (accent, border) stay here; user-facing copy
// (title, description, detail) is read from i18n at render via the
// `console.frameworkPicker.simpleChoices.<key>.*` keys.
const SIMPLE_CHOICES: readonly {
  id: string;
  i18nKey: "frontend" | "backend";
  accent: string;
  border: string;
}[] = [
  {
    id: "next",
    i18nKey: "frontend",
    accent: "from-sodium/20 to-sodium/5",
    border: "hover:border-sodium/60",
  },
  {
    id: "hono",
    i18nKey: "backend",
    accent: "from-cyan-500/20 to-cyan-500/5",
    border: "hover:border-cyan-500/60",
  },
] as const;

// Which catalog view to show. Driven by the workspace-type step: studio
export type FrameworkPickerVariant = "simple" | "advanced";

interface FrameworkPickerProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  // Which view to render. The parent derives this from the workspace
  variant: FrameworkPickerVariant;
  // Fires when the user commits a selection by clicking a simple-mode
  onAdvance?: () => void;
}

export function FrameworkPicker({ selectedId, onSelect, variant, onAdvance }: FrameworkPickerProps) {
  const t = useTranslations("console.frameworkPicker");
  const initialCategory = useMemo<CategoryId>(() => {
    const fw = FRAMEWORK_OPTIONS.find((f) => f.id === selectedId);
    return fw?.group ?? "frontend";
  }, [selectedId]);
  const [activeCategory, setActiveCategory] = useState<CategoryId>(initialCategory);

  const visible = useMemo(
    () => FRAMEWORK_OPTIONS.filter((f) => f.group === activeCategory),
    [activeCategory],
  );

  if (variant === "simple") {
    return (
      <div className="flex flex-col gap-2.5">
        {SIMPLE_CHOICES.map((choice) => {
          const isSelected = selectedId === choice.id;
          return (
            <button
              key={choice.id}
              type="button"
              onClick={() => {
                onSelect(choice.id);
                onAdvance?.();
              }}
              className={cn(
                "group relative flex items-center gap-4 rounded-xl border bg-card/60 px-4 py-4 text-left transition-all",
                "bg-gradient-to-br",
                choice.accent,
                isSelected
                  ? "border-sodium/60 shadow-[0_0_0_1px_rgba(240, 166, 90,0.35)]"
                  : `border-border ${choice.border}`,
              )}
              aria-pressed={isSelected}
            >
              <div className="flex-none flex items-center justify-center h-11 w-11 rounded-lg bg-card border border-border/60 text-cream">
                <FrameworkLogo id={choice.id} className="h-6 w-6" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[15px] font-semibold text-cream leading-tight">{t(`simpleChoices.${choice.i18nKey}.title`)}</p>
                <p className="text-[12px] text-cream/60 mt-0.5 leading-snug">{t(`simpleChoices.${choice.i18nKey}.description`)}</p>
                <p className="text-[11px] text-cream/45 mt-1 leading-snug">{t(`simpleChoices.${choice.i18nKey}.detail`)}</p>
              </div>
              <ArrowRight className="flex-none h-4 w-4 text-cream/45 group-hover:text-cream transition-colors" aria-hidden />
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        role="tablist"
        aria-label={t("categoriesAriaLabel")}
        className="relative flex items-center overflow-x-auto border-b border-border/60 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {CATEGORY_IDS.map((catId) => {
          const isActive = catId === activeCategory;
          return (
            <button
              key={catId}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveCategory(catId)}
              className={cn(
                "group relative flex-none whitespace-nowrap px-3.5 py-2.5 text-[12.5px] font-medium tracking-tight transition-colors",
                isActive
                  ? "text-cream"
                  : "text-cream/50 hover:text-cream/90",
              )}
            >
              <span className="relative z-10">{t(`categories.${catId}`)}</span>
              <span
                aria-hidden
                className={cn(
                  "absolute inset-x-3.5 -bottom-px h-[2px] rounded-full bg-sodium transition-opacity duration-150",
                  isActive ? "opacity-100" : "opacity-0",
                )}
              />
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-1 max-h-[340px] overflow-y-auto pr-0.5">
        {visible.map((option) => {
          const isSelected = selectedId === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onSelect(option.id)}
              className={cn(
                "group relative flex items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                isSelected
                  ? "border-sodium/50 bg-sodium/[0.06]"
                  : "border-border/40 bg-card/40 hover:border-cream/[0.10] hover:bg-card/70",
              )}
              aria-pressed={isSelected}
            >
              <div
                className={cn(
                  "flex-none flex items-center justify-center h-8 w-8",
                  isSelected ? "text-cream" : "text-cream/80 group-hover:text-cream",
                )}
              >
                <FrameworkLogo id={option.id} className="h-full w-full" />
              </div>
              <div className="flex-1 min-w-0">
                <p
                  className={cn(
                    "text-[13px] font-medium leading-tight truncate",
                    isSelected ? "text-cream" : "text-cream/90",
                  )}
                >
                  {option.label}
                </p>
                <p className="text-[11px] text-cream/45 mt-0.5 leading-snug truncate">
                  {option.tagline}
                </p>
              </div>
              {isSelected && (
                <Check className="flex-none h-4 w-4 text-sodium" aria-hidden />
              )}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => onSelect("blank")}
        className={cn(
          "w-full py-2 text-[12px] transition-colors",
          selectedId === "blank"
            ? "text-sodium font-medium"
            : "text-cream/40 hover:text-cream/70",
        )}
      >
        {selectedId === "blank" ? "✓ blank project" : "or start blank"}
      </button>
    </div>
  );
}
