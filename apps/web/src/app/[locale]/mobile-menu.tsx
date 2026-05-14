"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/routing";

const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL!;

export function MobileMenu({ consoleUrl }: { consoleUrl: string }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const t = useTranslations("nav");
  const tAuth = useTranslations("auth");

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <div className="md:hidden" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-cream/[0.08] bg-cream/[0.03] text-cream/65 transition-colors hover:text-cream"
        aria-label={t("mobile.toggleMenu")}
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

      <div
        className={`fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity duration-300 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setOpen(false)}
      />

      <div
        className={`fixed top-16 left-0 right-0 z-50 border-b border-cream/[0.06] bg-ink/95 backdrop-blur-xl transition-all duration-300 ease-out ${
          open
            ? "translate-y-0 opacity-100"
            : "-translate-y-2 pointer-events-none opacity-0"
        }`}
      >
        <div className="flex flex-col gap-1 px-6 py-4">
          <Link
            href="/"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("mobile.home")}
          </Link>
          <Link
            href="/#autonomy"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("product.autonomy")}
          </Link>
          <Link
            href="/#composition"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("product.composition")}
          </Link>
          <Link
            href="/#how-it-works"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("product.howItWorks")}
          </Link>
          <Link
            href="/#safety"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("mobile.safety")}
          </Link>
          <Link
            href="/#pricing"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("product.pricing")}
          </Link>
          <a
            href={DOCS_URL}
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("product.docs")}
          </a>
          <hr className="my-2 border-cream/[0.06]" />
          <p className="px-3 py-1 text-[11px] font-medium uppercase tracking-[0.22em] text-cream/35">
            {t("resources.label")}
          </p>
          <Link
            href="/blog"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("resources.blog")}
          </Link>
          <Link
            href="/vs"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("resources.comparisons")}
          </Link>
          <Link
            href="/concepts"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("resources.concepts")}
          </Link>
          <Link
            href="/solutions"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("resources.solutions")}
          </Link>
          <Link
            href="/glossary"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("resources.glossary")}
          </Link>
          <hr className="my-2 border-cream/[0.06]" />
          <Link
            href="/privacy"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("mobile.privacy")}
          </Link>
          <Link
            href="/terms"
            onClick={() => setOpen(false)}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("mobile.terms")}
          </Link>
          <hr className="my-2 border-cream/[0.06]" />
          <a
            href={`${consoleUrl}/sign-in`}
            className="rounded-lg px-3 py-2.5 text-sm font-medium text-cream/70 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {tAuth("signIn")}
          </a>
          <a
            href={`${consoleUrl}/sign-up`}
            className="mt-1 rounded-md bg-sodium px-3 py-2.5 text-center text-sm font-semibold text-ink transition hover:bg-sodium-strong"
          >
            {tAuth("getStarted")}
          </a>
        </div>
      </div>
    </div>
  );
}
