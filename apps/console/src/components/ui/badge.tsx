// SPDX-License-Identifier: MIT

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-all focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-sodium/30 bg-sodium/10 text-sodium hover:bg-sodium/20",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-terra/30 bg-terra/10 text-terra hover:bg-terra/20",
        outline: "border-cream/[0.06] bg-cream/[0.03] text-cream/60 hover:border-cream/[0.12] hover:text-cream/75",
        success:
          "border-sodium/30 bg-sodium/10 text-sodium",
        warning:
          "border-sodium/30 bg-sodium/10 text-sodium",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
