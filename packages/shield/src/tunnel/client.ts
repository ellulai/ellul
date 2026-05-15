import WebSocket, { type RawData } from "ws";
import * as https from "node:https";
import * as http from "node:http";
import { encodeFrame, decodeFrame, FrameType } from "@ellul.ai/tunnel-protocol";

const MAX_BODY_CHUNK = 65_536;
const REQUEST_TIMEOUT_MS = 120_000;
const WS_CONNECT_TIMEOUT_MS = 10_000;

export interface TunnelStats {
  requests: number;
  bytesUp: number;
  bytesDown: number;
  connected: boolean;
  subdomain: string | null;
  uptime: number;
}

interface ActiveHttp {
  kind: "http";
  req: http.ClientRequest;
  timer: NodeJS.Timeout;
}

interface ActiveWsConn {
  kind: "ws";
  ws: WebSocket;
}

type ActiveEntry = ActiveHttp | ActiveWsConn;

export class TunnelClient {
  private ws: WebSocket | null = null;
  private subdomain: string | null = null;
  private active = new Map<number, ActiveEntry>();
  private reconnectDelay = 1000;
  private shouldReconnect = true;
  private connectResolve: ((sub: string) => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private startTime = 0;
  private _stats = { requests: 0, bytesUp: 0, bytesDown: 0 };

  constructor(
    private readonly relayUrl: string,
    private readonly token: string,
    private readonly localPort: number = 443,
    private readonly requestedSubdomain?: string,
    private readonly onLog: (msg: string) => void = () => {},
  ) {}

  connect(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.doConnect();
    });
  }

  private doConnect(): void {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (this.requestedSubdomain) headers["X-Subdomain"] = this.requestedSubdomain;

    const ws = new WebSocket(`${this.relayUrl}/tunnel`, { headers });
    this.ws = ws;

    ws.on("open", () => {
      this.startTime = Date.now();
      this.reconnectDelay = 1000;
      this.onLog("connected to relay");
    });

    ws.on("message", (data: RawData) => {
      const buf = Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.concat(data);
      this.handleFrame(buf);
    });

    ws.on("close", (_code, reason) => {
      this.onLog(`disconnected: ${reason?.toString() || "unknown"}`);
      for (const [id, entry] of this.active) {
        if (entry.kind === "http") {
          entry.req.destroy();
          clearTimeout(entry.timer);
        } else {
          entry.ws.close();
        }
        this.active.delete(id);
      }

      if (this.shouldReconnect && !this.connectReject) {
        this.onLog(`reconnecting in ${this.reconnectDelay / 1000}s...`);
        setTimeout(() => this.doConnect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
      }
    });

    ws.on("error", (err) => {
      if (this.connectReject) {
        this.connectReject(err);
        this.connectResolve = null;
        this.connectReject = null;
      }
    });

    ws.on("ping", () => ws.pong());
  }

  private handleFrame(data: Buffer): void {
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(data);
    } catch {
      return;
    }

    switch (frame.type) {
      case FrameType.HELLO: {
        const { subdomain } = JSON.parse(frame.payload.toString());
        this.subdomain = subdomain;
        if (this.connectResolve) {
          this.connectResolve(subdomain);
          this.connectResolve = null;
          this.connectReject = null;
        }
        break;
      }

      case FrameType.REQUEST: {
        this._stats.requests++;
        const meta = JSON.parse(frame.payload.toString()) as {
          method: string;
          url: string;
          headers: Record<string, string | string[]>;
        };
        const isUpgrade =
          typeof meta.headers.upgrade === "string" &&
          meta.headers.upgrade.toLowerCase() === "websocket";
        if (isUpgrade) this.handleWsUpgrade(frame.id, meta);
        else this.handleHttpRequest(frame.id, meta);
        break;
      }

      case FrameType.REQ_BODY: {
        const entry = this.active.get(frame.id);
        if (entry?.kind === "http") {
          entry.req.write(frame.payload);
          this._stats.bytesDown += frame.payload.length;
        }
        break;
      }

      case FrameType.REQ_END: {
        const entry = this.active.get(frame.id);
        if (entry?.kind === "http") entry.req.end();
        break;
      }

      case FrameType.WS_DATA: {
        const entry = this.active.get(frame.id);
        if (entry?.kind === "ws") {
          const isBinary = frame.payload[0] === 1;
          entry.ws.send(frame.payload.subarray(1), { binary: isBinary });
          this._stats.bytesDown += frame.payload.length - 1;
        }
        break;
      }

      case FrameType.WS_CLOSE: {
        const entry = this.active.get(frame.id);
        if (entry?.kind === "ws") {
          entry.ws.close();
          this.active.delete(frame.id);
        }
        break;
      }
    }
  }

  // ── HTTP request → localhost ──

  private handleHttpRequest(
    id: number,
    meta: {
      method: string;
      url: string;
      headers: Record<string, string | string[]>;
    },
  ): void {
    const headers: Record<string, string | string[]> = { ...meta.headers };
    headers.host = "localhost";

    const localReq = https.request({
      hostname: "localhost",
      port: this.localPort,
      method: meta.method,
      path: meta.url,
      headers: headers as http.OutgoingHttpHeaders,
      rejectUnauthorized: false,
    });

    const timer = setTimeout(() => {
      localReq.destroy();
      this.sendError(id, "Request timeout");
      this.active.delete(id);
    }, REQUEST_TIMEOUT_MS);

    this.active.set(id, { kind: "http", req: localReq, timer });

    localReq.on("response", (localRes) => {
      clearTimeout(timer);

      const resHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(localRes.headers)) {
        if (v === undefined) continue;
        if (k === "set-cookie" && Array.isArray(v)) {
          resHeaders[k] = v;
          continue;
        }
        resHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
      }

      this.send(
        FrameType.RESPONSE,
        id,
        Buffer.from(
          JSON.stringify({ status: localRes.statusCode, headers: resHeaders }),
        ),
      );

      localRes.on("data", (chunk: Buffer) => {
        this._stats.bytesUp += chunk.length;
        let off = 0;
        while (off < chunk.length) {
          const end = Math.min(off + MAX_BODY_CHUNK, chunk.length);
          this.send(FrameType.RES_BODY, id, chunk.subarray(off, end));
          off = end;
        }
      });

      localRes.on("end", () => {
        this.send(FrameType.RES_END, id, Buffer.alloc(0));
        this.active.delete(id);
      });

      localRes.on("error", () => {
        this.sendError(id, "Local response error");
        this.active.delete(id);
      });
    });

    localReq.on("error", (err) => {
      clearTimeout(timer);
      this.sendError(id, `Connection refused: ${err.message}`);
      this.active.delete(id);
    });
  }

  // ── WebSocket upgrade → localhost ──

  private handleWsUpgrade(
    id: number,
    meta: {
      method: string;
      url: string;
      headers: Record<string, string | string[]>;
    },
  ): void {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta.headers)) {
      if (k === "connection" || k === "transfer-encoding") continue;
      headers[k] = Array.isArray(v) ? v[0] : v;
    }
    headers.host = "localhost";

    const localWs = new WebSocket(
      `wss://localhost:${this.localPort}${meta.url}`,
      { headers, rejectUnauthorized: false },
    );

    const timer = setTimeout(() => {
      localWs.close();
      this.sendError(id, "WebSocket connect timeout");
      this.active.delete(id);
    }, WS_CONNECT_TIMEOUT_MS);

    localWs.on("open", () => {
      clearTimeout(timer);

      this.send(
        FrameType.RESPONSE,
        id,
        Buffer.from(JSON.stringify({ status: 101, headers: {} })),
      );
      this.active.set(id, { kind: "ws", ws: localWs });

      localWs.on("message", (data: RawData, isBinary: boolean) => {
        const buf = Buffer.isBuffer(data)
          ? data
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : Buffer.concat(data);
        this._stats.bytesUp += buf.length;
        const flag = Buffer.alloc(1, isBinary ? 1 : 0);
        this.send(FrameType.WS_DATA, id, Buffer.concat([flag, buf]));
      });

      const wsCleanup = () => {
        if (this.active.has(id)) {
          this.send(FrameType.WS_CLOSE, id, Buffer.alloc(0));
          this.active.delete(id);
        }
      };
      localWs.on("close", wsCleanup);
      localWs.on("error", wsCleanup);
    });

    localWs.on("error", (err) => {
      clearTimeout(timer);
      this.sendError(id, `WebSocket failed: ${err.message}`);
      this.active.delete(id);
    });
  }

  // ── Frame I/O ──

  private send(type: FrameType, id: number, payload: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeFrame(type, id, payload));
    }
  }

  private sendError(id: number, message: string): void {
    this.send(
      FrameType.ERROR,
      id,
      Buffer.from(JSON.stringify({ message })),
    );
  }

  // ── Public API ──

  getStats(): TunnelStats {
    return {
      ...this._stats,
      connected: this.ws?.readyState === WebSocket.OPEN,
      subdomain: this.subdomain,
      uptime: this.startTime
        ? Math.floor((Date.now() - this.startTime) / 1000)
        : 0,
    };
  }

  close(): void {
    this.shouldReconnect = false;
    for (const [, entry] of this.active) {
      if (entry.kind === "http") {
        entry.req.destroy();
        clearTimeout(entry.timer);
      } else {
        entry.ws.close();
      }
    }
    this.active.clear();
    this.ws?.close(1000, "client shutdown");
    this.ws = null;
  }
}
