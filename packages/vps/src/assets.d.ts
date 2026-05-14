// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/** Shell scripts inlined as text strings by the static-text esbuild plugin */
declare module '*.sh' {
  const content: string;
  export default content;
}

/** Text files inlined as text strings by the static-text esbuild plugin */
declare module '*.txt' {
  const content: string;
  export default content;
}

/** Config files inlined as text strings by the static-text esbuild plugin */
declare module '*.conf' {
  const content: string;
  export default content;
}

/** Markdown files inlined as text strings by the static-text esbuild plugin */
declare module '*.md' {
  const content: string;
  export default content;
}

/** C source files inlined as text strings by the static-text esbuild plugin */
declare module '*.c' {
  const content: string;
  export default content;
}

/** C header files inlined as text strings by the static-text esbuild plugin */
declare module '*.h' {
  const content: string;
  export default content;
}

/** systemd unit files inlined as text strings by the static-text esbuild plugin */
declare module '*.service' {
  const content: string;
  export default content;
}

declare module '*.slice' {
  const content: string;
  export default content;
}

declare module '*.timer' {
  const content: string;
  export default content;
}
