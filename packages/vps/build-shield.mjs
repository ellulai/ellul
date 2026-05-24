import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

function staticTextPlugin() {
  return {
    name: "static-text",
    setup(build) {
      build.onResolve({ filter: /^@ellul\.ai\/vps-ui\// }, (args) => {
        const subpath = args.path.replace("@ellul.ai/vps-ui/", "");
        const distPath = path.resolve("../vps-ui/dist", subpath);
        if (subpath === "chat") {
          return { path: distPath + "/index.html", namespace: "static-text" };
        }
        if (subpath === "code-browser") {
          return { path: distPath + "/index.html", namespace: "static-text" };
        }
        return { path: distPath + ".js", namespace: "static-text" };
      });
      build.onLoad({ filter: /.*/, namespace: "static-text" }, (args) => {
        const text = fs.readFileSync(args.path, "utf8");
        return { contents: `export default ${JSON.stringify(text)};`, loader: "js" };
      });
      // Handle .js imports from static/ directory as text (they use `import X from '../static/file.js'`)
      build.onResolve({ filter: /\.js$/ }, (args) => {
        if (args.importer && args.importer.includes("sovereign-shield") && args.path.includes("static/")) {
          const resolved = path.resolve(path.dirname(args.importer), args.path);
          return { path: resolved, namespace: "static-text" };
        }
        return undefined;
      });
      build.onResolve({ filter: /^@ellul\.ai\/i18n-consts/ }, (args) => {
        const subpath = args.path.replace("@ellul.ai/i18n-consts/", "");
        return { path: path.resolve("../i18n-consts/src", subpath + ".ts") };
      });
    },
  };
}

esbuild.build({
  entryPoints: ["src/services/auth/sovereign-shield/src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "/tmp/shield-bundle.js",
  loader: {
    ".html": "text",
    ".map": "text",
  },
  external: [
    "fs", "path", "crypto", "http", "https", "url", "events", "stream",
    "util", "os", "net", "tls", "dns", "zlib", "buffer", "querystring",
    "string_decoder", "child_process", "worker_threads", "perf_hooks",
    "async_hooks", "better-sqlite3", "@solana/web3.js", "bip39",
    "ed25519-hd-key", "/_auth/static/pqc-mlkem.js",
  ],
  plugins: [staticTextPlugin()],
}).then(() => console.log("Shield bundle built")).catch((e) => { console.error(e); process.exit(1); });
