"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { Link } from "@/i18n/routing";
import type { DocMeta } from "@/lib/docs";
import { SidebarNav } from "./sidebar-nav";

interface SidebarShellProps {
  sections: Record<string, DocMeta[]>;
  children: React.ReactNode;
}

export function SidebarShell({ sections, children }: SidebarShellProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const t = useTranslations("docs");

  // Close drawer on navigation.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll when drawer is open on mobile.
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-cream/[0.06] bg-ink/80 px-4 py-3 backdrop-blur-xl lg:hidden">
        <Link href="/" className="flex items-center gap-2 text-base font-semibold tracking-tight text-cream">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 32 32"
            className="h-6 w-6"
            aria-hidden="true"
          >
            <rect width="32" height="32" rx="6" fill="#0B0B0F" />
            <text
              x="16"
              y="22"
              textAnchor="middle"
              fontFamily="ui-monospace, monospace"
              fontSize="20"
              fontWeight="700"
              fill="#F0A65A"
            >
              e
            </text>
          </svg>
          <span>ellul</span>
          <span className="ml-1 text-xs font-medium text-sodium">{t("sidebar.label")}</span>
        </Link>
        <button
          onClick={() => setOpen(!open)}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-cream/[0.08] bg-cream/[0.03] text-cream/65 transition-colors hover:text-cream"
          aria-label={open ? t("sidebar.closeMenu") : t("sidebar.openMenu")}
          aria-expanded={open}
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            {open ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
      </header>

      {/* Backdrop for mobile drawer */}
      <div
        className={`fixed inset-0 z-30 bg-black/50 backdrop-blur-sm transition-opacity duration-200 lg:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      {/*
        Mobile: container is plain block, body scrolls naturally, sidebar floats as a fixed drawer.
        Desktop (lg+): container is a flex row pinned to viewport height; sidebar and main each get their own scroll region.
      */}
      <div className="lg:flex lg:h-screen lg:gap-4 lg:p-4">
        {/* Sidebar: drawer on mobile, fixed-width scrollable panel on desktop. */}
        <aside
          className={`
            fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] overflow-y-auto bg-ink p-6 transition-transform duration-200 ease-out
            lg:static lg:z-auto lg:h-full lg:w-64 lg:max-w-none lg:shrink-0 lg:overflow-y-auto lg:bg-transparent lg:transition-none lg:panel-ascente
            ${open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
          `}
        >
          <SidebarNav sections={sections} />
        </aside>

        {/* Main content: body-scroll on mobile, internal scroll on desktop. */}
        <main className="min-w-0 lg:flex-1 lg:overflow-y-auto">{children}</main>
      </div>
    </>
  );
}
