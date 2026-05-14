// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import * as http from "http";

import {
  CLAUDE_LAUNCH_TRACE_ENV,
  claudeLaunchTrace,
} from "../../../../shared/claude-launch-trace";
import type { ShieldRedeemClient } from "../application/ports";

const REDEEM_TIMEOUT_MS = 5_000;

// HTTP client for shield's /api/internal/claude-oat/redeem. Uses bare
// node:http so the launcher bundle stays lean — execve happens within ms.
export class HttpShieldRedeemClient implements ShieldRedeemClient {
  constructor(
    private readonly host = "127.0.0.1",
    private readonly port = 3005,
    private readonly redeemPath = "/api/internal/claude-oat/redeem",
    private readonly serviceName = "agent-bridge",
  ) {}

  redeem(issuanceToken: string, serviceToken: string): Promise<string> {
    const tr = process.env[CLAUDE_LAUNCH_TRACE_ENV] ?? "no-trace";
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ issuanceToken });
      claudeLaunchTrace("launcher", tr, "redeem-http-request", {
        host: this.host,
        port: this.port,
        path: this.redeemPath,
        bodyLen: body.length,
        timeoutMs: REDEEM_TIMEOUT_MS,
      });
      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path: this.redeemPath,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body).toString(),
            authorization: `Bearer ${serviceToken}`,
            "x-service-name": this.serviceName,
          },
          timeout: REDEEM_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const latencyMs = Date.now() - startedAt;
            if (res.statusCode !== 200) {
              claudeLaunchTrace("launcher", tr, "redeem-http-non200", {
                latencyMs,
                status: res.statusCode ?? null,
                bodyLen: text.length,
                bodyHead: text.slice(0, 200),
              });
              try {
                const parsed = JSON.parse(text) as {
                  error?: string;
                  code?: string;
                };
                reject(
                  new Error(
                    `${res.statusCode} ${parsed.code ?? "unknown"}: ${
                      parsed.error ?? text.slice(0, 200)
                    }`,
                  ),
                );
              } catch {
                reject(new Error(`${res.statusCode}: ${text.slice(0, 200)}`));
              }
              return;
            }
            try {
              const parsed = JSON.parse(text) as { token?: string };
              if (typeof parsed.token === "string" && parsed.token.length > 0) {
                claudeLaunchTrace("launcher", tr, "redeem-http-200", {
                  latencyMs,
                  tokenLen: parsed.token.length,
                });
                resolve(parsed.token);
              } else {
                claudeLaunchTrace("launcher", tr, "redeem-http-no-token", {
                  latencyMs,
                  bodyHead: text.slice(0, 200),
                });
                reject(new Error("redeem response missing token"));
              }
            } catch (err) {
              claudeLaunchTrace("launcher", tr, "redeem-http-parse-fail", {
                latencyMs,
                error: (err as Error).message,
                bodyHead: text.slice(0, 200),
              });
              reject(new Error(`redeem response parse: ${(err as Error).message}`));
            }
          });
        },
      );
      req.on("timeout", () => {
        claudeLaunchTrace("launcher", tr, "redeem-http-timeout", {
          latencyMs: Date.now() - startedAt,
          timeoutMs: REDEEM_TIMEOUT_MS,
        });
        req.destroy(new Error(`redeem timed out after ${REDEEM_TIMEOUT_MS}ms`));
      });
      req.on("error", (err) => {
        claudeLaunchTrace("launcher", tr, "redeem-http-error", {
          latencyMs: Date.now() - startedAt,
          error: err.message,
          errno: (err as NodeJS.ErrnoException).code ?? null,
        });
        reject(err);
      });
      req.write(body);
      req.end();
    });
  }
}
