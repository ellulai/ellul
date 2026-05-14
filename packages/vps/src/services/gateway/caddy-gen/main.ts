// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul-caddy-gen CLI
 *
 * Generates a complete Caddyfile to stdout.
 * Called by the enforcer on deployment model switches.
 *
 * Usage:
 *   node /usr/local/bin/ellul-caddy-gen \
 *     --model cloudflare \
 *     --main-domain abc12345-srv.ellul.ai \
 *     --code-domain abc12345-code.ellul.ai \
 *     --dev-domain abc12345-dev.ellul.app
 */

import { readFileSync } from "fs";
import { generateCaddyfileContent } from "./caddyfile";
import type { VpsDeploymentModel } from "../../shared/constants";
import { normalizeDeploymentModel } from "../../shared/constants";

const ORIGIN_TAG_FILE = "/etc/ellul/origin-tag";
const PLATFORM_ZONE_FILE = "/etc/ellul/platform-zone";
const APP_ZONE_FILE = "/etc/ellul/app-zone";
const CONSOLE_ORIGIN_FILE = "/etc/ellul/console-origin";
const CUSTOM_DOMAIN_FILE = "/etc/ellul/custom-domain";

function readRequiredFileSync(path: string): string {
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`${path} is empty`);
  return value;
}

function readOptionalFileSync(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--") && i + 1 < argv.length) {
      args[arg.slice(2)] = argv[i + 1]!;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const model = args["model"] as string | undefined;
const mainDomain = args["main-domain"] as string | undefined;
const codeDomain = args["code-domain"] as string | undefined;
const devDomain = args["dev-domain"] as string | undefined;

if (!model || !mainDomain || !codeDomain || !devDomain) {
  process.stderr.write(
    "Usage: ellul-caddy-gen --model <proxied|direct> " +
    "--main-domain <domain> --code-domain <domain> --dev-domain <domain>\n"
  );
  process.exit(1);
}

const VALID_MODELS = ["proxied", "direct", "cloudflare", "gateway"];
if (!VALID_MODELS.includes(model)) {
  process.stderr.write(`Invalid model: ${model}. Must be one of: ${VALID_MODELS.join(", ")}.\n`);
  process.exit(1);
}

const deploymentModel: VpsDeploymentModel = normalizeDeploymentModel(model);

const platform = (args["platform"] || "linux") as "linux" | "macos";

// Read origin tag from disk — written by enforcer on every heartbeat.
// Missing on first boot (before enforcer runs); caddy-gen omits origin hostname.
const originTag = (() => {
  try { return readFileSync(ORIGIN_TAG_FILE, "utf8").trim() || undefined; } catch { return undefined; }
})();

const content = generateCaddyfileContent({
  deploymentModel,
  mainDomain,
  codeDomain,
  devDomain,
  platformZone: readRequiredFileSync(PLATFORM_ZONE_FILE),
  appZone: readRequiredFileSync(APP_ZONE_FILE),
  consoleOrigin: readRequiredFileSync(CONSOLE_ORIGIN_FILE),
  customDomain: readOptionalFileSync(CUSTOM_DOMAIN_FILE),
  platform,
  originTag,
});

process.stdout.write(content);
