// SPDX-License-Identifier: MIT

// Global keyboard shortcuts for the dashboard.

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export interface KeyBinding {
  // Human-readable label, e.g. "Cmd+1"
  label: string;
  // Returns true when the event matches this binding
  match: (e: KeyboardEvent) => boolean;
}

function mod(e: KeyboardEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

// Cmd/Ctrl + 1 — Switch to Chat tab
export const switchChat: KeyBinding = {
  label: isMac ? "\u2318+1" : "Ctrl+1",
  match: (e) => mod(e) && e.key === "1",
};

// Cmd/Ctrl + 2 — Switch to Code tab
export const switchCode: KeyBinding = {
  label: isMac ? "\u2318+2" : "Ctrl+2",
  match: (e) => mod(e) && e.key === "2",
};

// Cmd/Ctrl + 3 — Switch to Preview tab
export const switchPreview: KeyBinding = {
  label: isMac ? "\u2318+3" : "Ctrl+3",
  match: (e) => mod(e) && e.key === "3",
};

// Cmd/Ctrl + \ — Toggle terminal drawer
export const toggleTerminal: KeyBinding = {
  label: isMac ? "\u2318+\\" : "Ctrl+\\",
  match: (e) => mod(e) && e.key === "\\",
};

// Cmd/Ctrl + N — New thread
export const newThread: KeyBinding = {
  label: isMac ? "\u2318+N" : "Ctrl+N",
  match: (e) => mod(e) && e.key === "n" && !e.shiftKey,
};
