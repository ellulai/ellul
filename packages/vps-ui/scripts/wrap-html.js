// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Post-build script: wraps single-file HTML into JS module exports.
 * Produces dist/chat.js and dist/code-browser.js that export the HTML string.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "..", "dist");

const entries = [
  { name: "chat", htmlPath: resolve(distDir, "chat", "index.html") },
  { name: "code-browser", htmlPath: resolve(distDir, "code-browser", "index.html") },
];

for (const { name, htmlPath } of entries) {
  if (!existsSync(htmlPath)) {
    console.warn(`[wrap-html] Skipping ${name}: ${htmlPath} not found`);
    continue;
  }
  const html = readFileSync(htmlPath, "utf8");
  const jsModule = `export default ${JSON.stringify(html)};\n`;
  const outPath = resolve(distDir, `${name}.js`);
  writeFileSync(outPath, jsModule);
  console.log(`[wrap-html] ${name}.js (${(html.length / 1024).toFixed(1)} KB)`);
}
