/**
 * Generates a standalone AppType declaration from the private API.
 *
 * Run: pnpm --filter @ellul.ai/api-client generate
 *
 * Uses tsc --emitDeclarationOnly to produce a self-contained app-type.d.ts
 * that encodes all Hono route types. Only references hono/* and @ellul.ai/types
 * (both public). The output is committed to generated/ and synced to the public repo.
 */
import { execSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, cpSync } from "fs";
import { resolve, dirname } from "path";

const PKG_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const MONO_ROOT = resolve(PKG_ROOT, "../..");
const TMP_DIR = resolve(PKG_ROOT, ".gen-tmp");
const OUT_DIR = resolve(PKG_ROOT, "generated");

if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const tsconfig = {
  compilerOptions: {
    emitDeclarationOnly: true,
    declaration: true,
    outDir: TMP_DIR,
    skipLibCheck: true,
    strict: true,
    module: "ESNext",
    moduleResolution: "Bundler",
    target: "ES2022",
    esModuleInterop: true,
  },
  include: [
    resolve(MONO_ROOT, "apps/api/src/app.ts"),
    resolve(MONO_ROOT, "apps/api/src/client.ts"),
  ],
};

const tsconfigPath = resolve(TMP_DIR, "tsconfig.json");
writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2));

console.log("Generating AppType declaration...");

try {
  execSync(`npx tsc --project ${tsconfigPath}`, {
    cwd: MONO_ROOT,
    stdio: "pipe",
  });
} catch {
  // tsc may error on .sh imports but still emits the types we need
}

const appDts = resolve(TMP_DIR, "app.d.ts");
if (!existsSync(appDts)) {
  console.error("FATAL: tsc did not emit app.d.ts");
  process.exit(1);
}

// Verify no private package references leaked through
const content = readFileSync(appDts, "utf-8");
const privateRefs = content.match(/@ellul\.ai\/(db|api)/g);
if (privateRefs) {
  console.error(`FATAL: app.d.ts references private packages: ${[...new Set(privateRefs)].join(", ")}`);
  process.exit(1);
}

// Copy to generated/
writeFileSync(resolve(OUT_DIR, "app-type.d.ts"), content);

// Clean up
rmSync(TMP_DIR, { recursive: true });
rmSync(tsconfigPath, { force: true });

console.log(`Generated: packages/api-client/generated/app-type.d.ts (${(content.length / 1024).toFixed(0)} KB)`);
