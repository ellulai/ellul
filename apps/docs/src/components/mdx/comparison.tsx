"use client";

import { useTranslations } from "next-intl";

interface ComparisonRow {
  label: string;
  paas: string;
  vps: string;
  ellul: string;
}

interface ComparisonTableProps {
  rows: ComparisonRow[];
}

export function ComparisonTable({ rows }: ComparisonTableProps) {
  const t = useTranslations("docs.comparison");

  return (
    <div className="not-prose my-8 overflow-x-auto rounded-xl border border-[rgba(245, 239, 230, 0.07)]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[rgba(245, 239, 230, 0.07)] bg-[#0B0B0F] text-left">
            <th className="px-4 py-3 font-medium text-cream" />
            <th className="px-4 py-3 font-medium text-cream/60">
              {t("paasLabel")}
            </th>
            <th className="px-4 py-3 font-medium text-cream/60">
              {t("vpsLabel")}
            </th>
            <th className="px-4 py-3 font-medium text-sodium">
              {t("ellulLabel")}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[rgba(245, 239, 230, 0.07)]">
          {rows.map((row) => (
            <tr key={row.label}>
              <td className="px-4 py-3 font-medium text-cream">
                {row.label}
              </td>
              <td className="px-4 py-3 text-cream/75">{row.paas}</td>
              <td className="px-4 py-3 text-cream/75">{row.vps}</td>
              <td className="px-4 py-3 font-medium text-sodium">
                {row.ellul}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
