// SPDX-License-Identifier: MIT

import { cn } from "@/lib/utils";

interface SkeletonProps {
  className?: string;
}

function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-cream/[0.06]",
        className
      )}
    />
  );
}

function SkeletonText({ className }: SkeletonProps) {
  return <Skeleton className={cn("h-4 w-full", className)} />;
}

function SkeletonCard({ className }: SkeletonProps) {
  return (
    <div className={cn("p-4 rounded-xl bg-secondary/30 border border-border/50", className)}>
      <div className="flex items-start gap-3">
        <Skeleton className="w-10 h-10 rounded-lg shrink-0" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
        <Skeleton className="w-5 h-5 rounded shrink-0" />
      </div>
    </div>
  );
}

function SkeletonAppList({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

function SkeletonRow({ columns = 4, className }: { columns?: number } & SkeletonProps) {
  return (
    <div className={cn("flex items-center gap-3 px-3 py-2.5", className)}>
      {Array.from({ length: columns }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn("h-3.5", i === 0 ? "w-1/4" : "flex-1")}
        />
      ))}
    </div>
  );
}

function SkeletonTable({ rows = 5, columns = 4, className }: { rows?: number; columns?: number } & SkeletonProps) {
  return (
    <div className={cn("rounded-lg border border-border/50 overflow-hidden", className)}>
      <div className="flex items-center gap-3 px-3 py-2 bg-cream/[0.02] border-b border-border/50">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className={cn("h-3", i === 0 ? "w-1/5" : "flex-1")} />
        ))}
      </div>
      <div className="divide-y divide-border/30">
        {Array.from({ length: rows }).map((_, i) => (
          <SkeletonRow key={i} columns={columns} />
        ))}
      </div>
    </div>
  );
}

function SkeletonList({ count = 3, className }: { count?: number } & SkeletonProps) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2">
          <Skeleton className="w-8 h-8 rounded-lg shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

export { Skeleton, SkeletonText, SkeletonCard, SkeletonAppList, SkeletonRow, SkeletonTable, SkeletonList };
