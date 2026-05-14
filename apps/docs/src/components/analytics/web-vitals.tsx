"use client";

import { useReportWebVitals } from "next/web-vitals";
import posthog from "posthog-js";

export function WebVitalsReporter({ surface }: { surface: "web" | "docs" }) {
  useReportWebVitals((metric) => {
    if (typeof window === "undefined") return;
    if (!posthog.__loaded) return;

    posthog.capture("$performance", {
      surface,
      metric_name: metric.name,
      metric_id: metric.id,
      metric_label: metric.label,
      value: metric.value,
      delta: metric.delta,
      rating: (metric as { rating?: string }).rating,
    });
  });
  return null;
}
