// SPDX-License-Identifier: MIT
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 60 seconds - data stays fresh longer
            gcTime: 5 * 60 * 1000, // 5 minutes - keep in cache longer
            refetchOnWindowFocus: false, // Don't refetch when user switches tabs
            refetchOnReconnect: true, // Do refetch when network reconnects
            retry: 2, // Retry failed requests twice
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
