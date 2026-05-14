import { defineConfig } from "tsup";
// @ts-expect-error — Node built-in
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

export default defineConfig({
  entry: {
    "cloud/index": "src/cloud/index.ts",
    "cloud/mcp-server": "src/cloud/mcp-server.ts",
  },
  format: ["esm"],
  splitting: true,
  clean: true,
  dts: true,
  target: "node20",
  platform: "node",
  // Native module — must not be bundled. Resolved at runtime only in local mode.
  external: ["better-sqlite3"],
  define: {
    __SHIELD_VERSION__: JSON.stringify(pkg.version),
  },
});
