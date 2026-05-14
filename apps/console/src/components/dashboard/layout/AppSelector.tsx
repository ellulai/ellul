// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Layers,
  Package,
  Monitor,
  Library,
  FolderOpen,
  Play,
} from "lucide-react";
import { EllulLogo } from "@ellul.ai/ui/ellul-logo";
import {
  useAppsList,
  type ApiApp,
  type ApiPackage,
} from "@/contexts/AppsListContext";

const FRAMEWORK_LABELS: Record<string, string> = {
  next: "Next.js",
  nextjs: "Next.js",
  nuxt: "Nuxt",
  vite: "Vite",
  vue: "Vue",
  cra: "React",
  "create-react-app": "React",
  svelte: "Svelte",
  astro: "Astro",
  gatsby: "Gatsby",
  remix: "Remix",
  static: "Static",
  html: "HTML",
  node: "Node.js",
  express: "Express",
  fastify: "Fastify",
  hono: "Hono",
  koa: "Koa",
  nestjs: "NestJS",
  python: "Python",
  turbo: "Turborepo",
  nx: "Nx",
  lerna: "Lerna",
  "pnpm-workspace": "pnpm Workspaces",
  unknown: "Unknown",
  dotnet: ".NET",
  golang: "Go",
  "spring-boot": "Spring Boot",
  flask: "Flask",
  django: "Django",
  fastapi: "FastAPI",
  streamlit: "Streamlit",
  gradio: "Gradio",
  phoenix: "Phoenix",
  rails: "Rails",
  laravel: "Laravel",
};

type AppType = ApiApp["type"];
type PackageType = ApiPackage["type"];

const TYPE_CONFIG = {
  frontend: { icon: Monitor, color: "text-sodium" },
  backend: { icon: EllulLogo, color: "text-sodium" },
  library: { icon: Library, color: "text-cream/65" },
  monorepo: { icon: Layers, color: "text-cyan-500" },
  unknown: { icon: Package, color: "text-cream/60" },
} as const;

function getTypeConfig(type: AppType | PackageType) {
  return TYPE_CONFIG[type] ?? TYPE_CONFIG.unknown;
}

function frameworkLabel(fw: string): string {
  return FRAMEWORK_LABELS[fw] ?? fw;
}

// Flat list item for the folder selector. Every selectable entry — standalone
interface FolderEntry {
  directory: string;
  label: string;
  framework: string;
  type: AppType | PackageType;
  indent: boolean;
  previewable: boolean;
}

function ScopeRow({ entry, isSelected, isPreviewing, onSelect, onPreview }: {
  entry: FolderEntry;
  isSelected: boolean;
  isPreviewing: boolean;
  onSelect: () => void;
  onPreview?: () => void;
}) {
  const { icon: Icon, color } = getTypeConfig(entry.type);
  const bg = isSelected ? `${color.replace("text-", "bg-")}/10` : "";
  return (
    <div className={`flex items-center w-full px-3 py-3 sm:py-2 hover:bg-secondary active:bg-secondary/80 transition-colors ${bg}`}>
      <button
        onClick={onSelect}
        className="flex items-center gap-3 sm:gap-2.5 min-w-0 flex-1 text-left"
      >
        {isSelected && <span className={`w-2 h-2 rounded-full ${color.replace("text-", "bg-")} shrink-0`} />}
        <Icon className={`h-5 w-5 sm:h-4 sm:w-4 shrink-0 ${isSelected ? color : "text-cream/60"}`} />
        <span className={`text-sm sm:text-[13px] truncate ${isSelected ? "text-cream font-medium" : "text-cream/75"}`}>{entry.label}</span>
      </button>
      <div className="flex items-center gap-2.5 shrink-0 ml-2">
        <span className="text-[11px] text-cream/60">{frameworkLabel(entry.framework)}</span>
        {entry.previewable && onPreview && (
          <button
            onClick={(e) => { e.stopPropagation(); onPreview(); }}
            className={`p-2 sm:p-1.5 -mr-1 rounded-lg sm:rounded-md transition-colors ${
              isPreviewing
                ? "text-sodium bg-sodium/15"
                : "text-cream/45 hover:text-sodium hover:bg-sodium/10 active:bg-sodium/15"
            }`}
            title={isPreviewing ? "Previewing" : "Start preview"}
          >
            <Play className={`h-4 w-4 sm:h-3.5 sm:w-3.5 ${isPreviewing ? "fill-sodium" : ""}`} />
          </button>
        )}
      </div>
    </div>
  );
}

export function AppSelector({
  selectedApp,
  previewApp,
  onPreviewStart,
}: {
  serverId: string;
  serverDomain: string;
  selectedApp: string | null;
  // Directory of the app currently being previewed (from preview status).
  previewApp?: string | null;
  // Called when the user clicks play — parent can optimistically update preview state.
  onPreviewStart?: (directory: string) => void;
}) {
  const t = useTranslations("console.appSelector");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { sandboxes, isLoading } = useAppsList();

  const handlePreview = useCallback((dir: string) => {
    // Notify parent → sets visiblePreviewApp → flows as requestedPreviewApp
    onPreviewStart?.(dir);
  }, [onPreviewStart]);

  const navigateTo = useCallback(
    (directory: string) => {
      const encoded = directory.split("/").map(encodeURIComponent).join("/");
      const qs = searchParams.toString();
      router.push(`/dashboard/app/${encoded}${qs ? `?${qs}` : ""}`);
    },
    [router, searchParams],
  );

  const [showDropdown, setShowDropdown] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; right: number } | null>(null);

  // Resolve the active sandbox from the current selection.
  const activeSandbox = useMemo(() => {
    if (!selectedApp) return sandboxes[0] ?? null;
    const sandboxId = selectedApp.split("/")[0];
    return sandboxes.find((s) => s.id === sandboxId) ?? sandboxes[0] ?? null;
  }, [sandboxes, selectedApp]);

  // Build scoped sections from the active sandbox.
  interface ScopeGroup {
    label: string;
    entries: FolderEntry[];
  }

  const { monorepoEntry, standaloneApps, groups, allEntries } = useMemo(() => {
    if (!activeSandbox) return { monorepoEntry: null as FolderEntry | null, standaloneApps: [] as FolderEntry[], groups: [] as ScopeGroup[], allEntries: [] as FolderEntry[] };
    let monorepoEntry: FolderEntry | null = null;
    const standaloneApps: FolderEntry[] = [];
    const groupMap = new Map<string, FolderEntry[]>();

    for (const app of activeSandbox.apps) {
      if (app.isMonorepo) {
        const rawLabel = app.displayName || app.name;
        monorepoEntry = {
          directory: app.directory,
          // Show the project name but clarify it's a monorepo root
          label: rawLabel === "workspace" ? t("monorepoRoot") : rawLabel,
          framework: app.framework,
          type: "monorepo",
          indent: false,
          previewable: false,
        };

        for (const pkg of app.workspacePackages ?? []) {
          const shortName = pkg.name.split("/").pop() || pkg.name;
          const relPath = pkg.directory.slice(app.directory.length + 1);
          const groupKey = relPath.split("/")[0] || "other";
          const folderEntry: FolderEntry = {
            directory: pkg.directory,
            label: shortName,
            framework: pkg.framework,
            type: pkg.type,
            indent: false,
            previewable: pkg.previewable,
          };
          if (!groupMap.has(groupKey)) groupMap.set(groupKey, []);
          groupMap.get(groupKey)!.push(folderEntry);
        }
      } else {
        standaloneApps.push({
          directory: app.directory,
          label: app.displayName || app.name,
          framework: app.framework,
          type: app.type,
          indent: false,
          previewable: app.previewable,
        });
      }
    }

    // Stable group order: alphabetical by directory name
    const groups: ScopeGroup[] = Array.from(groupMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entries]) => ({
        label: key.charAt(0).toUpperCase() + key.slice(1),
        entries,
      }));

    const allGroupEntries = groups.flatMap((g) => g.entries);
    const all = [
      ...(monorepoEntry ? [monorepoEntry] : []),
      ...standaloneApps,
      ...allGroupEntries,
    ];
    return { monorepoEntry, standaloneApps, groups, allEntries: all };
  }, [activeSandbox]);

  // Current selection label. For single-app sandboxes, prefer the sandbox's
  const currentEntry = allEntries.find((f) => f.directory === selectedApp);
  const currentLabel = allEntries.length > 1
    ? (currentEntry?.label || activeSandbox?.displayName || "Select Scope")
    : (activeSandbox?.displayName || currentEntry?.label || "Select Scope");
  const currentType = currentEntry?.type || "unknown";
  const currentFramework = currentEntry?.framework || null;
  const CurrentIcon = getTypeConfig(currentType).icon;
  const currentColor = getTypeConfig(currentType).color;

  const handleOpenDropdown = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
    setShowDropdown(true);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowDropdown(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary/50">
        <Package className="h-3.5 w-3.5 text-cream/60 animate-pulse" />
        <span className="text-xs text-cream/60">…</span>
      </div>
    );
  }

  if (allEntries.length === 0) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary/50">
        <FolderOpen className="h-3.5 w-3.5 text-cream/60" />
        <span className="text-xs text-cream/60">{t("noProjects")}</span>
      </div>
    );
  }

  // Only show the dropdown trigger if there's more than one selectable entry
  const hasMultipleFolders = allEntries.length > 1;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={hasMultipleFolders ? handleOpenDropdown : undefined}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary border border-border ${
          hasMultipleFolders ? "hover:bg-secondary/80 cursor-pointer" : "cursor-default"
        } transition-colors`}
      >
        <CurrentIcon className={`h-3.5 w-3.5 ${currentColor}`} />
        <span className="text-xs text-cream/85 font-medium max-w-[120px] truncate">{currentLabel}</span>
        {currentFramework && (
          <span className="text-[10px] text-cream/60 hidden sm:inline">({frameworkLabel(currentFramework)})</span>
        )}
        {hasMultipleFolders && (
          <ChevronDown className={`h-3 w-3 text-cream/60 transition-transform ${showDropdown ? "rotate-180" : ""}`} />
        )}
      </button>

      {showDropdown && createPortal(
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-[60] sm:animate-in sm:fade-in-0 sm:duration-150"
            onClick={(e) => { e.stopPropagation(); setShowDropdown(false); }}
          />

          {/* Mobile: bottom sheet modal. Desktop: positioned dropdown. */}
          <div
            className={`fixed z-[70] bg-card border border-border shadow-2xl
              inset-x-0 bottom-0 rounded-t-2xl max-h-[70vh]
              sm:inset-auto sm:rounded-lg sm:w-72 sm:max-h-[400px]
              animate-in slide-in-from-bottom-4 sm:slide-in-from-bottom-0 sm:fade-in-0 sm:zoom-in-95 duration-200`}
            style={dropdownPosition ? {
              // Desktop only — mobile uses inset-x-0 bottom-0
              ...(typeof window !== "undefined" && window.innerWidth >= 640 ? { top: dropdownPosition.top, right: dropdownPosition.right } : {}),
            } : undefined}
          >
            {/* Drag handle (mobile) */}
            <div className="flex justify-center pt-2 pb-1 sm:hidden">
              <div className="w-8 h-1 rounded-full bg-ink-1" />
            </div>

            <div className="p-3 sm:p-2 border-b border-border">
              <span className="text-xs sm:text-[10px] font-semibold text-cream/60 uppercase tracking-wider px-1">{t("selectScope")}</span>
            </div>

            <div className="overflow-y-auto py-1" style={{ maxHeight: "calc(70vh - 60px)" }}>
              {monorepoEntry && (
                <ScopeRow entry={monorepoEntry} isSelected={monorepoEntry.directory === selectedApp} isPreviewing={false} onSelect={() => { navigateTo(monorepoEntry.directory); setShowDropdown(false); }} />
              )}
              {standaloneApps.length > 0 && standaloneApps.map((entry) => (
                <ScopeRow key={entry.directory} entry={entry} isSelected={entry.directory === selectedApp} isPreviewing={previewApp === entry.directory} onSelect={() => { navigateTo(entry.directory); setShowDropdown(false); }} onPreview={() => handlePreview(entry.directory)} />
              ))}
              {groups.map((group, i) => (
                <div key={group.label} className={(monorepoEntry || standaloneApps.length > 0 || i > 0) ? "border-t border-border mt-1 pt-1" : ""}>
                  <div className="px-3 sm:px-3 py-1.5 sm:py-1">
                    <span className="text-xs sm:text-[10px] font-semibold text-cream/45 uppercase tracking-wider">{group.label}</span>
                  </div>
                  {group.entries.map((entry) => (
                    <ScopeRow key={entry.directory} entry={entry} isSelected={entry.directory === selectedApp} isPreviewing={previewApp === entry.directory} onSelect={() => { navigateTo(entry.directory); setShowDropdown(false); }} onPreview={() => handlePreview(entry.directory)} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
