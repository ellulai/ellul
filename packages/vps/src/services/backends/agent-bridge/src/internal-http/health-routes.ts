// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { IncomingMessage, ServerResponse } from "http";

import { DEFAULT_SESSION, VALID_SESSIONS } from "../config";

export async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      defaultSession: DEFAULT_SESSION,
      validSessions: VALID_SESSIONS,
    }),
  );
}
