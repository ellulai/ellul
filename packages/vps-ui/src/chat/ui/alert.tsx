// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/ui/alert.tsx

import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@shared/utils";

const alertVariants = cva(
  "relative grid w-full items-start gap-x-2 gap-y-0.5 rounded-xl border px-3.5 py-3 text-sm has-[>svg]:grid-cols-[1rem_1fr] has-[>svg]:has-[[data-slot=alert-action]]:grid-cols-[1rem_1fr_auto] has-[>svg]:gap-x-2 [&>svg]:mt-0.5 [&>svg]:size-4",
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "border-border bg-muted/40 text-foreground [&>svg]:text-muted-foreground",
        error: "border-destructive/30 bg-destructive/5 text-destructive/90 [&>svg]:text-destructive",
        warning: "border-terra/30 bg-terra/5 text-terra/90 [&>svg]:text-terra",
        info: "border-sodium/30 bg-sodium/5 text-sodium/90 [&>svg]:text-sodium",
        success: "border-emerald-500/30 bg-emerald-500/5 text-emerald-300 [&>svg]:text-emerald-400",
      },
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      className={cn(alertVariants({ variant }), className)}
      data-slot="alert"
      role="alert"
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("font-medium [svg~&]:col-start-2", className)}
      data-slot="alert-title"
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("opacity-80 [svg~&]:col-start-2", className)}
      data-slot="alert-description"
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("row-start-1 row-end-3 self-center", className)}
      data-slot="alert-action"
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
