// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/** HTML files loaded as text strings by the static-text esbuild plugin */
declare module '*.html' {
  const content: string;
  export default content;
}

/** Source map files loaded as text strings by the static-text esbuild plugin */
declare module '*.js.map' {
  const content: string;
  export default content;
}
