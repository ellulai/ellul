// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// CI-LINT-EXEMPT-CLAUDE-AUTH-MIGRATION
//
// One-shot migration from the legacy ~/.claude.json:primaryApiKey storage
// to the greenfield Claude OAT credential subsystem. This file is the ONLY
// place in bridge source where reads-then-writes of ~/.claude.json are
// permitted, and only to STRIP the legacy fields after handing the token
// to sovereign-shield.
//
// Lifecycle:
//   - Runs once at bridge startup (idempotent).
//   - If shield's credential is empty AND ~/.claude.json holds a valid
//     primaryApiKey, POST it to shield's /save, then strip
//     primaryApiKey + oauthAccount from claude.json.
//
// Removal target: delete this file two releases after deploy lands. CI
// lint exemption is keyed on the marker comment above; the rest of the
// bounded context cannot opt in.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { ShieldOatGateway } from "../application/ports";
import { logEvent } from "../../../shared/event-log";

const OAT_PATTERN = /^sk-ant-oat01-[A-Za-z0-9_-]{60,200}$/;

export async function migrateLegacyClaudeJson(
  gateway: ShieldOatGateway,
): Promise<void> {
  const home = process.env.HOME ?? "/home/dev";
  const cfgPath = path.join(home, ".claude.json");

  let raw: string;
  try {
    raw = fs.readFileSync(cfgPath, "utf8");
  } catch {
    return;
  }

  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    logEvent("claude.oat.migration.skip", {
      reason: "claude-json-unparseable",
    });
    return;
  }

  const legacyToken = cfg["primaryApiKey"];
  if (typeof legacyToken !== "string" || !OAT_PATTERN.test(legacyToken)) {
    return;
  }

  const peek = await gateway.peek();
  if (!peek) {
    logEvent("claude.oat.migration.skip", { reason: "shield-unreachable" });
    return;
  }
  if (peek.state !== "empty") {
    logEvent("claude.oat.migration.skip", {
      reason: "shield-already-has-credential",
      state: peek.state,
    });
    stripLegacyFields(cfgPath, cfg);
    return;
  }

  const result = await gateway.save({
    token: legacyToken,
    sessionId: "migration-from-claude-json",
  });
  if (!result.ok) {
    logEvent("claude.oat.migration.fail", {
      status: result.status,
      body: result.body,
    });
    return;
  }

  // Log a non-reversible fingerprint instead of any plaintext slice — even
  // a 20-char prefix leaks ~7 chars past the fixed `sk-ant-oat01-` header.
  logEvent("claude.oat.migration.ok", {
    tokenFingerprint: crypto
      .createHash("sha256")
      .update(legacyToken)
      .digest("hex")
      .slice(0, 16),
  });

  stripLegacyFields(cfgPath, cfg);
}

function stripLegacyFields(
  cfgPath: string,
  cfg: Record<string, unknown>,
): void {
  if (
    cfg["primaryApiKey"] === undefined &&
    cfg["oauthAccount"] === undefined
  ) {
    return;
  }
  delete cfg["primaryApiKey"];
  delete cfg["oauthAccount"];
  try {
    const tmp = `${cfgPath}.migrate-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, cfgPath);
    logEvent("claude.oat.migration.stripped", { cfgPath });
  } catch (err) {
    logEvent("claude.oat.migration.strip-fail", {
      err: (err as Error).message,
    });
  }
}
