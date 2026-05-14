// SPDX-License-Identifier: MIT

import { cn } from "@/lib/utils";
import { useDelayedLoading } from "@/hooks/use-delayed-loading";

type SpinnerSize = "xs" | "sm" | "default" | "lg" | "xl";
type SpinnerColor = "current" | "primary" | "muted" | "danger";

interface SpinnerProps {
  className?: string;
  size?: SpinnerSize;
  // Semantic color. Defaults to "current" (inherits parent text color).
  color?: SpinnerColor;
  // Optional label shown below the spinner
  label?: string;
  // Delay in ms before the spinner becomes visible.
  delay?: number;
}

const sizes: Record<SpinnerSize, { wh: string; border: string; innerInset: string; innerBorder: string }> = {
  xs:      { wh: "w-3 h-3",   border: "border-[1.5px]", innerInset: "inset-px",  innerBorder: "border-[1.5px]" },
  sm:      { wh: "w-4 h-4",   border: "border-2",       innerInset: "inset-0.5", innerBorder: "border-[1.5px]" },
  default: { wh: "w-6 h-6",   border: "border-2",       innerInset: "inset-1",   innerBorder: "border-2" },
  lg:      { wh: "w-8 h-8",   border: "border-[3px]",   innerInset: "inset-1.5", innerBorder: "border-2" },
  xl:      { wh: "w-12 h-12", border: "border-[3px]",   innerInset: "inset-2",   innerBorder: "border-2" },
};

const colors: Record<SpinnerColor, { track: string; outerArc: string; innerArc: string }> = {
  current: { track: "border-cream/[0.06]", outerArc: "border-transparent border-t-current",  innerArc: "border-transparent border-b-current/40" },
  primary: { track: "border-cream/[0.06]", outerArc: "border-transparent border-t-sodium",   innerArc: "border-transparent border-b-sodium/40" },
  muted:   { track: "border-cream/[0.06]", outerArc: "border-transparent border-t-cream/30", innerArc: "border-transparent border-b-cream/[0.12]" },
  danger:  { track: "border-cream/[0.06]", outerArc: "border-transparent border-t-terra",    innerArc: "border-transparent border-b-terra/40" },
};

// Spinner — canonical loading indicator.
export function Spinner({ className, size = "default", color = "current", label, delay = 0 }: SpinnerProps) {
  const visible = useDelayedLoading(true, delay);
  const { wh, border, innerInset, innerBorder } = sizes[size];
  const { track, outerArc, innerArc } = colors[color];

  if (delay > 0 && !visible) return null;

  // to prevent twMerge from stripping border-t-* / border-b-* overrides.
  return (
    <div className={cn("animate-in fade-in duration-150", label && "flex flex-col items-center", className)}>
      <div className={cn("relative", wh)}>
        <div className={`absolute inset-0 rounded-full ${border} ${track}`} />
        <div className={`absolute inset-0 rounded-full ${border} ${outerArc} animate-spin`} />
        <div
          className={`absolute ${innerInset} rounded-full ${innerBorder} ${innerArc} animate-spin`}
          style={{ animationDirection: "reverse", animationDuration: "1.5s" }}
        />
      </div>
      {label && <p className="mt-2 text-xs text-muted-foreground/60">{label}</p>}
    </div>
  );
}

// SpinnerOverlay — centered spinner for section/panel loading states.
export function SpinnerOverlay({
  label,
  size = "default",
  color = "muted",
  className,
}: {
  label?: string;
  size?: SpinnerSize;
  color?: SpinnerColor;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-1 items-center justify-center", className)}>
      <Spinner size={size} color={color} label={label} />
    </div>
  );
}

// LoadingScreen — full-page centered spinner.
export function LoadingScreen({ message = "Loading..." }: { message?: string }) {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center gap-3"
      style={{
        background:
          "radial-gradient(ellipse at 50% -5%, rgba(240, 166, 90, 0.06) 0%, transparent 55%), #0B0B0F",
        backgroundAttachment: "fixed",
      }}
    >
      <Spinner size="lg" color="primary" />
      <p className="text-xs text-cream/45">{message}</p>
    </div>
  );
}
