"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { DocMeta } from "@/lib/docs";

interface SidebarNavProps {
  sections: Record<string, DocMeta[]>;
}

export function SidebarNav({ sections }: SidebarNavProps) {
  const pathname = usePathname();
  const t = useTranslations("docs");

  return (
    <>
      <Link href="/" className="mb-8 block">
        <span className="flex items-center gap-2 text-lg font-semibold tracking-tight text-cream">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 32 32"
            className="h-7 w-7"
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
          ellul
        </span>
        <span className="mt-0.5 block pl-9 text-xs font-medium text-sodium">
          {t("sidebar.label")}
        </span>
      </Link>

      <nav className="space-y-6">
        {Object.entries(sections).map(([section, docs]) => (
          <div key={section}>
            <h3 className="mb-2 text-[10px] font-semibold tracking-tight text-sodium/70">
              {section}
            </h3>
            <ul className="space-y-0.5">
              {docs.map((doc) => {
                const isActive = pathname === `/${doc.slug}`;
                return (
                  <li key={doc.slug}>
                    <Link
                      href={`/${doc.slug}`}
                      className={`block rounded-md px-3 py-1.5 text-sm transition-all ${
                        isActive
                          ? "border-l-2 border-sodium bg-gradient-to-r from-sodium/15 to-transparent text-cream font-medium"
                          : "text-cream/75 hover:bg-cream/5 hover:text-cream"
                      }`}
                    >
                      {doc.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
}
