// SPDX-License-Identifier: MIT

import { useState, useEffect } from "react";

// Delays a loading state so fast operations never flash a spinner.
// If the operation completes before the threshold, the spinner never shows.
export function useDelayedLoading(
  isLoading: boolean,
  delayMs = 300,
  minVisibleMs = 500,
): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isLoading) {
      const timer = setTimeout(() => setVisible(true), delayMs);
      return () => clearTimeout(timer);
    }

    if (visible) {
      const timer = setTimeout(() => setVisible(false), minVisibleMs);
      return () => clearTimeout(timer);
    }

    return;
  }, [isLoading, delayMs, minVisibleMs, visible]);

  return visible;
}
