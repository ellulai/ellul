// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Markdown agent-context files inlined as strings by the consumer's
 * static-text esbuild plugin (vps' tsup). The plugin matches files
 * inside node_modules too, so this declaration is what tsc looks at
 * when it can't run the bundler.
 */
declare module '*.md' {
  const content: string;
  export default content;
}
