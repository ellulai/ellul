import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  dts: false, // Manual .d.ts — rollup-dts can't handle .sh imports
  esbuildOptions(options) {
    options.loader = { ...options.loader, ".sh": "text", ".yaml": "text", ".go": "text" };
  },
});
