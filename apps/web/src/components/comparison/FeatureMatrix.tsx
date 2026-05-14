import { deriveAdvantage, type FeatureRow } from "@/content/comparisons/schema";

function CellValue({ value }: { value: boolean | string }) {
  if (typeof value === "boolean") {
    return (
      <span
        className={
          value
            ? "inline-flex items-center gap-1 text-cream"
            : "inline-flex items-center gap-1 text-cream/40"
        }
      >
        <span aria-hidden>{value ? "✓" : "✗"}</span>
        <span className="sr-only">{value ? "yes" : "no"}</span>
      </span>
    );
  }
  return <>{value}</>;
}

function AdvantageDot({
  advantage,
}: {
  advantage: "ellul" | "competitor" | "tie";
}) {
  if (advantage === "tie") {
    return (
      <span
        className="inline-block h-1.5 w-1.5 rounded-full bg-cream/30"
        aria-label="tie"
      />
    );
  }
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${
        advantage === "ellul" ? "bg-sodium" : "bg-cream/40"
      }`}
      aria-label={
        advantage === "ellul" ? "ellul advantage" : "competitor advantage"
      }
    />
  );
}

export interface FeatureMatrixProps {
  competitorName: string;
  rows: FeatureRow[];
  caption?: string;
}

export function FeatureMatrix({
  competitorName,
  rows,
  caption,
}: FeatureMatrixProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-cream/[0.08] bg-cream/[0.015]">
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
              Capability
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
            <th scope="col" className="hidden w-12 px-2 py-3 sm:table-cell">
              <span className="sr-only">Advantage</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const advantage = deriveAdvantage(row);
            return (
              <tr
                key={row.id}
                className="border-b border-cream/[0.04] last:border-b-0"
              >
                <td className="px-4 py-3 text-cream/85 sm:px-6">
                  {row.capability}
                  {row.note && (
                    <span className="mt-1 block text-xs text-cream/45">
                      {row.note}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-cream/55 sm:px-6">
                  <CellValue value={row.competitor} />
                </td>
                <td
                  className={`px-4 py-3 sm:px-6 ${
                    advantage === "ellul" ? "text-cream" : "text-cream/55"
                  }`}
                >
                  <CellValue value={row.ellul} />
                </td>
                <td className="hidden px-2 py-3 text-center sm:table-cell">
                  <AdvantageDot advantage={advantage} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
