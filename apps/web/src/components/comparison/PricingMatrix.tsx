import type { PricingRow } from "@/content/comparisons/schema";

export interface PricingMatrixProps {
  competitorName: string;
  rows: PricingRow[];
}

export function PricingMatrix({ competitorName, rows }: PricingMatrixProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-cream/[0.08] bg-cream/[0.015]">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-cream/[0.06] bg-cream/[0.02]">
            <th
              scope="col"
              className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-[0.18em] text-cream/45 sm:px-6"
            >
              Tier
            </th>
            <th
              scope="col"
              className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-[0.18em] text-cream/45 sm:px-6"
            >
              {competitorName}
            </th>
            <th
              scope="col"
              className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-[0.18em] text-sodium sm:px-6"
            >
              ellul
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-cream/[0.04] last:border-b-0"
            >
              <td className="px-4 py-3 text-cream/85 sm:px-6">
                {row.tier}
                {row.note && (
                  <span className="mt-1 block text-xs text-cream/45">
                    {row.note}
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-cream/55 sm:px-6">
                {row.competitor}
              </td>
              <td className="px-4 py-3 text-cream sm:px-6">{row.ellul}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
