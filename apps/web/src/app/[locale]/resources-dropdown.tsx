"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";

export function ResourcesDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const t = useTranslations("nav");

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div
      ref={ref}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-sm text-cream/55 transition-colors hover:text-cream"
      >
        {t("resources.label")}
        <svg
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <div
        className={`absolute left-0 top-full pt-2 transition-all duration-150 ${
          open ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1 pointer-events-none"
        }`}
      >
        <div className="min-w-[160px] rounded-lg border border-cream/[0.08] bg-ink/95 p-2 shadow-xl backdrop-blur-xl">
          <Link
            href="/blog"
            className="block rounded-md px-3 py-2 text-sm text-cream/65 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("resources.blog")}
          </Link>
          <Link
            href="/vs"
            className="block rounded-md px-3 py-2 text-sm text-cream/65 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("resources.comparisons")}
          </Link>
          <Link
            href="/concepts"
            className="block rounded-md px-3 py-2 text-sm text-cream/65 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("resources.concepts")}
          </Link>
          <Link
            href="/solutions"
            className="block rounded-md px-3 py-2 text-sm text-cream/65 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("resources.solutions")}
          </Link>
          <Link
            href="/glossary"
            className="block rounded-md px-3 py-2 text-sm text-cream/65 transition-colors hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("resources.glossary")}
          </Link>
        </div>
      </div>
    </div>
  );
}
