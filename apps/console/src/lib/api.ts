// SPDX-License-Identifier: MIT

import { hc } from "hono/client";
import type { AppType } from "@ellul.ai/api-client";

// // GET request with full type safety

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

// Create the type-safe client
export const api = hc<AppType>(API_URL, {
  // Include credentials for auth cookies
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, {
      ...init,
      credentials: "include",
    }),
});

// Fetch with retry and exponential backoff.
export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries = 5,
  baseDelay = 2000
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError!;
}

// Helper for handling API responses
export async function handleApiResponse<T>(
  response: Response
): Promise<{ data: T | null; error: string | null }> {
  if (!response.ok) {
    const error = await response.text();
    return { data: null, error: error || `HTTP ${response.status}` };
  }

  const data = await response.json();
  return { data: data as T, error: null };
}

// Re-export the API URL for other uses
export { API_URL };
