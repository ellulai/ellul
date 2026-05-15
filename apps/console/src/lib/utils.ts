// SPDX-License-Identifier: MIT

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isElectronApp(): boolean {
  return typeof window !== "undefined" && "electronShield" in window;
}

export function isAndroidApp(): boolean {
  return typeof window !== "undefined" && "androidShield" in window;
}

export function isNativeApp(): boolean {
  return isElectronApp() || isAndroidApp();
}
