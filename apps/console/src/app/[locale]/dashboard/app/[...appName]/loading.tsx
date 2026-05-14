// SPDX-License-Identifier: MIT
"use client";

import { Skeleton } from "@/components/ui/skeleton";

export default function AppLoading() {
  return (
    <div className="min-h-screen bg-card text-cream">
      {/* Header skeleton */}
      <header className="sticky top-0 z-40 bg-card/95 backdrop-blur-sm border-b border-border">
        <div className="flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <Skeleton className="w-8 h-8 rounded-lg" />
            <Skeleton className="h-5 w-24 hidden sm:block" />
            <Skeleton className="h-8 w-40 rounded-lg" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-32 rounded-lg" />
            <Skeleton className="w-8 h-8 rounded-lg" />
          </div>
        </div>
      </header>

      {/* Main content skeleton */}
      <div className="flex flex-col h-[calc(100vh-3.5rem)]">
        {/* Tab bar skeleton */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-border/50 bg-card">
          <Skeleton className="h-8 w-20 rounded-lg" />
          <Skeleton className="h-8 w-20 rounded-lg" />
          <Skeleton className="h-8 w-20 rounded-lg" />
          <Skeleton className="h-8 w-20 rounded-lg" />
        </div>

        {/* Content area skeleton */}
        <div className="flex-1 p-4 space-y-4">
          <Skeleton className="h-32 w-full rounded-xl" />
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </div>
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
