import { useTranslations } from "next-intl";

export interface LastUpdatedProps {
  date: string;
  /** Optional ISO datetime; if omitted, the date string is used as-is. */
  isoDate?: string;
}

function formatDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function LastUpdated({ date, isoDate }: LastUpdatedProps) {
  const t = useTranslations("pages");
  return (
    <p className="text-[11px] font-mono uppercase tracking-[0.22em] text-cream/40">
      <span aria-hidden>·</span>{" "}
      <span>{t("rawMd.labelUpdated")}</span>{" "}
      <time dateTime={isoDate ?? date}>{formatDate(date)}</time>
    </p>
  );
}
