export interface PricingTableRow {
  tier: string;
  price: string;
  highlights?: string[];
}

export interface PricingTableProps {
  rows: PricingTableRow[];
  caption?: string;
}

export function PricingTable({ rows, caption }: PricingTableProps) {
  return (
    <div className="my-8 overflow-hidden rounded-2xl border border-cream/[0.08] bg-cream/[0.015]">
      <table className="w-full border-collapse text-sm">
        {caption && (
          <caption className="px-4 pt-4 pb-2 text-left text-[11px] font-medium uppercase tracking-[0.18em] text-cream/45 sm:px-6">
            {caption}
          </caption>
        )}
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
              className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-[0.18em] text-sodium sm:px-6"
            >
              Price
            </th>
            <th
              scope="col"
              className="px-4 py-3 text-left text-[11px] font-medium uppercase tracking-[0.18em] text-cream/45 sm:px-6"
            >
              Highlights
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.tier}
              className="border-b border-cream/[0.04] last:border-b-0"
            >
              <td className="px-4 py-3 text-cream/85 sm:px-6">{row.tier}</td>
              <td className="px-4 py-3 text-cream sm:px-6">{row.price}</td>
              <td className="px-4 py-3 text-cream/65 sm:px-6">
                {row.highlights && row.highlights.length > 0 ? (
                  <ul className="space-y-1">
                    {row.highlights.map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
