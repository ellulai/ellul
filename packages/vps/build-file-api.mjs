import * as esbuild from "esbuild";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.join(__dirname, "src/services/backends/file-api/src/main.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "/tmp/file-api-bundle.js",
  external: [
    "fs", "path", "crypto", "http", "https", "url", "events", "stream",
    "util", "os", "child_process", "ws", "chokidar",
  ],
  tsconfig: path.join(__dirname, "tsconfig.json"),
});
console.log("File-api bundle built");
