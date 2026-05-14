// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Apply theme class to document root
export function applyTheme(mode: "dark" | "light"): void {
  document.documentElement.classList.toggle("dark", mode === "dark");
}

// Default to dark mode
export function initTheme(): void {
  applyTheme("dark");
}
