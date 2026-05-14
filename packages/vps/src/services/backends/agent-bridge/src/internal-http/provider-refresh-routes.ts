// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { Effect } from "effect";
import type { IncomingMessage, ServerResponse } from "http";

import type { ApplicationRuntime } from "../composition/ApplicationLayer";
import { ProviderRegistry } from "../shared/ProviderRegistry";
import { gateLocalhostOnly } from "./acl";

export function makeProviderRefreshHandler(runtime: ApplicationRuntime) {
  return async function handleProviderRefresh(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!gateLocalhostOnly(req, res)) return;

    try {
      const effect = Effect.gen(function* () {
        const registry = yield* ProviderRegistry;
        return yield* registry.refresh();
      });
      await runtime.runPromise(effect);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
  };
}
