// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Local Router — Middleware-based HTTP request routing
 *
 * Replaces the monolithic if/else chain in the daemon request handler with
 * a composable router that supports:
 *   - Path pattern matching (exact + prefix + parameter extraction)
 *   - Middleware chains (auth, body parsing, STS verification, rate limiting)
 *   - Uniform error normalization
 *   - Request context with correlation ID propagation
 *
 * Designed for the local daemon's http.Server (no external framework deps).
 */

import * as http from 'http';
import * as crypto from 'crypto';

// ── Request Context ──

export interface RequestContext {
  /** Unique request correlation ID — included in response + all log entries. */
  correlationId: string;
  /** Parsed URL path. */
  path: string;
  /** HTTP method (uppercase). */
  method: string;
  /** URL search params. */
  params: URLSearchParams;
  /** Extracted path parameters (e.g., :id → ctx.pathParams.id). */
  pathParams: Record<string, string>;
  /** Parsed request body (set by bodyParser middleware). */
  body: unknown;
  /** Authenticated project slug (set by STS verification middleware). */
  projectSlug?: string;
  /** Raw request. */
  req: http.IncomingMessage;
  /** Raw response. */
  res: http.ServerResponse;
}

export type Middleware = (ctx: RequestContext, next: () => Promise<void>) => Promise<void>;
export type RouteHandler = (ctx: RequestContext) => Promise<void>;

// ── Route Definition ──

interface Route {
  method: string;         // GET, POST, PATCH, DELETE, or *
  pattern: string;        // exact path or pattern with :params
  patternParts: string[]; // split by /
  handler: RouteHandler;
  middleware: Middleware[];
  bodyLimit: number;
}

// ── Router ──

export class LocalRouter {
  private routes: Route[] = [];
  private globalMiddleware: Middleware[] = [];

  /** Add global middleware applied to all routes. */
  use(mw: Middleware): void {
    this.globalMiddleware.push(mw);
  }

  /** Register a GET route. */
  get(pattern: string, handler: RouteHandler, ...middleware: Middleware[]): void {
    this.addRoute('GET', pattern, handler, middleware);
  }

  /** Register a POST route. */
  post(pattern: string, handler: RouteHandler, ...middleware: Middleware[]): void {
    this.addRoute('POST', pattern, handler, middleware);
  }

  /** Register a PATCH route. */
  patch(pattern: string, handler: RouteHandler, ...middleware: Middleware[]): void {
    this.addRoute('PATCH', pattern, handler, middleware);
  }

  /** Register a DELETE route. */
  del(pattern: string, handler: RouteHandler, ...middleware: Middleware[]): void {
    this.addRoute('DELETE', pattern, handler, middleware);
  }

  private addRoute(method: string, pattern: string, handler: RouteHandler, middleware: Middleware[], bodyLimit = 65536): void {
    this.routes.push({
      method,
      pattern,
      patternParts: pattern.split('/').filter(Boolean),
      handler,
      middleware,
      bodyLimit,
    });
  }

  /** Set body limit for a specific route pattern. */
  setBodyLimit(pattern: string, limit: number): void {
    for (const route of this.routes) {
      if (route.pattern === pattern) route.bodyLimit = limit;
    }
  }

  /** Match a request to a route. Returns null if no match. */
  private matchRoute(method: string, path: string): { route: Route; pathParams: Record<string, string> } | null {
    const pathParts = path.split('/').filter(Boolean);

    for (const route of this.routes) {
      if (route.method !== '*' && route.method !== method) continue;

      const rParts = route.patternParts;
      if (rParts.length !== pathParts.length) continue;

      const params: Record<string, string> = {};
      let match = true;

      for (let i = 0; i < rParts.length; i++) {
        if (rParts[i].startsWith(':')) {
          params[rParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
        } else if (rParts[i] !== pathParts[i]) {
          match = false;
          break;
        }
      }

      if (match) return { route, pathParams: params };
    }

    return null;
  }

  /**
   * Create the http.Server request handler.
   * Handles routing, middleware execution, error normalization, and
   * correlation ID propagation.
   */
  handler(): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
    return async (req, res) => {
      const correlationId = crypto.randomBytes(8).toString('hex');
      const rawUrl = req.url || '/';
      const parsedUrl = new URL(rawUrl, 'http://localhost');
      const path = parsedUrl.pathname;
      const method = (req.method || 'GET').toUpperCase();

      // Set correlation ID on all responses
      res.setHeader('X-Correlation-Id', correlationId);

      const matched = this.matchRoute(method, path);
      if (!matched) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found', path, correlationId }));
        return;
      }

      const { route, pathParams } = matched;

      const ctx: RequestContext = {
        correlationId,
        path,
        method,
        params: parsedUrl.searchParams,
        pathParams,
        body: null,
        req,
        res,
      };

      // Build middleware chain: global → route-specific → handler
      const chain = [...this.globalMiddleware, ...route.middleware];
      let idx = 0;

      const next = async (): Promise<void> => {
        if (idx < chain.length) {
          const mw = chain[idx++];
          await mw(ctx, next);
        } else {
          // End of middleware chain — execute handler
          await route.handler(ctx);
        }
      };

      try {
        await next();
      } catch (err) {
        if (!res.headersSent) {
          const message = err instanceof Error ? err.message : 'Internal server error';
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: message, correlationId }));
        }
      }
    };
  }
}

// ── Built-in Middleware ──

/**
 * JSON body parser middleware.
 * Reads and parses the request body, respecting the per-route size limit.
 * Sets ctx.body to the parsed result (or null for GET/no-body requests).
 */
export function bodyParser(maxSize: number = 65536): Middleware {
  return async (ctx, next) => {
    if (ctx.method === 'GET' || ctx.method === 'HEAD') {
      await next();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;

    await new Promise<void>((resolve, reject) => {
      ctx.req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxSize) {
          ctx.req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      ctx.req.on('end', resolve);
      ctx.req.on('error', reject);
    });

    if (chunks.length > 0) {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        ctx.body = JSON.parse(raw);
      } catch {
        ctx.res.writeHead(400, { 'Content-Type': 'application/json' });
        ctx.res.end(JSON.stringify({ error: 'Invalid JSON body', correlationId: ctx.correlationId }));
        return; // Don't call next — request is done
      }
    }

    await next();
  };
}

/** Helper to send JSON responses with correlation ID. */
export function jsonResponse(ctx: RequestContext, status: number, body: unknown): void {
  ctx.res.writeHead(status, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify({ ...body as Record<string, unknown>, correlationId: ctx.correlationId }));
}
