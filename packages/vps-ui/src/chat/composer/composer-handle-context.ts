// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — port of
// pingdotgg/t3code@b0b7b38 apps/web/src/composerHandleContext.ts.

import { createContext, useContext, type MutableRefObject } from "react";
import type { ChatComposerHandle } from "./ChatComposer";

export type ComposerHandleRef = MutableRefObject<ChatComposerHandle | null>;

export const ComposerHandleContext = createContext<ComposerHandleRef | null>(null);

export function useComposerHandleContext(): ComposerHandleRef | null {
  return useContext(ComposerHandleContext);
}
