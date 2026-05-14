// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect } from "react";

// Hook that tracks browser tab visibility.
export function useTabVisibility(): boolean {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    // Set initial state
    setIsVisible(document.visibilityState === "visible");

    const handleVisibilityChange = () => {
      setIsVisible(document.visibilityState === "visible");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return isVisible;
}

// Hook that creates a polling interval that respects tab visibility.
export function useVisibilityPolling(
  callback: () => void | Promise<void>,
  interval: number | null,
  deps: React.DependencyList = []
): void {
  const isVisible = useTabVisibility();

  useEffect(() => {
    if (!isVisible || interval === null) return;

    // Run immediately when becoming visible
    callback();

    const id = setInterval(() => {
      if (document.visibilityState === "visible") {
        callback();
      }
    }, interval);

    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, interval, ...deps]);
}

// Hook for conditional polling based on both tab visibility AND component active state.
export function useConditionalPolling(
  callback: () => void | Promise<void>,
  interval: number,
  isActive: boolean
): void {
  const isVisible = useTabVisibility();
  const shouldPoll = isVisible && isActive;

  useEffect(() => {
    if (!shouldPoll) return;

    // Run immediately when conditions are met
    callback();

    const id = setInterval(() => {
      // Double-check visibility in case it changed between intervals
      if (document.visibilityState === "visible") {
        callback();
      }
    }, interval);

    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldPoll, interval]);
}
