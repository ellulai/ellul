import { defineConfig } from "tsup";
// @ts-expect-error — Node built-in, not in project lib scope
import { readFileSync } from "fs";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    version: "src/version.ts",
    "pinned-versions": "src/pinned-versions.ts",
    "configs/ai/index": "src/configs/ai/index.ts",
    "configs/index": "src/configs/index.ts",
    "scripts/index": "src/scripts/index.ts",
    "services/index": "src/services/index.ts",
    "services/shared/index": "src/services/shared/index.ts",
    "services/daemons/enforcer/bundle": "src/services/daemons/enforcer/bundle.ts",
    "services/backends/file-api/bundle": "src/services/backends/file-api/bundle.ts",
    "services/backends/agent-bridge/bundle": "src/services/backends/agent-bridge/bundle.ts",
    "services/backends/claude-launcher/bundle": "src/services/backends/claude-launcher/bundle.ts",
    "services/backends/ide/bundle": "src/services/backends/ide/bundle.ts",
    "services/auth/sovereign-shield/bundle": "src/services/auth/sovereign-shield/bundle.ts",
    "services/gateway/caddy-gen/bundle": "src/services/gateway/caddy-gen/bundle.ts",
    "services/gateway/term-proxy/index": "src/services/gateway/term-proxy/index.ts",
    "services/daemons/watchdog/index": "src/services/daemons/watchdog/index.ts",
    "services/daemons/ellul-namespaced/bundle": "src/services/daemons/ellul-namespaced/bundle.ts",
    "scripts/helpers/ellul-namespaced/index": "src/scripts/helpers/ellul-namespaced/index.ts",
    "auth/valid-operations": "src/auth/valid-operations.ts",
    "auth/bridge-contracts": "src/auth/bridge-contracts.ts",
    "capabilities/index": "src/capabilities/index.ts",
  },
  format: ["esm"],
  clean: true,
  sourcemap: true,
  dts: true,
  // Keep esbuild external - used at runtime for bundling service scripts
  external: ["esbuild"],
  // Bundle source-only workspace packages (no dist build, exports raw .ts)
  // INTO this artifact — Node 20 can't load .ts at runtime so externalizing
  // them crashes any consumer at startup with ERR_UNKNOWN_FILE_EXTENSION.
  noExternal: ["@ellul.ai/i18n-consts", "@ellul.ai/i18n-messages", "@ellul.ai/i18n"],
  // Load static assets as inlined text at build time
  esbuildPlugins: [{
    name: 'static-text',
    setup(build) {
      // HTML/JS/source maps in static/ directories
      build.onLoad({ filter: /[/\\]static[/\\][^/\\]+\.(html|js\.map|js)$/ }, (args) => {
        const content = readFileSync(args.path, 'utf8');
        return {
          contents: `export default ${JSON.stringify(content)}`,
          loader: 'js',
        };
      });
      // Shell scripts, text files, config files, markdown, C source/header,
      // and systemd unit files — inlined as default export
      build.onLoad({ filter: /\.(sh|txt|conf|md|c|h|service|slice|timer)$/ }, (args) => {
        const content = readFileSync(args.path, 'utf8');
        return {
          contents: `export default ${JSON.stringify(content)};`,
          loader: 'js',
        };
      });
    },
  }],
});
