import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { fail, EXIT } from './output';

const ENGINE_SOCK_VM = '/var/run/ellul-engine.sock';

let rpcId = 0;

export function getSocketPath(): string {
  const sockEnv = process.env.ELLUL_ENGINE_SOCK;
  if (sockEnv && fs.existsSync(sockEnv)) return sockEnv;

  const home = process.env.HOME || '';

  const limaSocket = path.join(home, '.lima', 'ellul', 'sock', 'ellul-engine.sock');
  if (fs.existsSync(limaSocket)) return limaSocket;

  if (fs.existsSync(ENGINE_SOCK_VM)) return ENGINE_SOCK_VM;

  const fallback = path.join(home, '.ellul', 'engine.sock');
  if (fs.existsSync(fallback)) return fallback;

  return '';
}

export function isEngineReachable(): boolean {
  const sock = getSocketPath();
  if (!sock) return false;
  try {
    return fs.statSync(sock).isSocket();
  } catch {
    return false;
  }
}

export function requireEngine(tag: string): string {
  const sock = getSocketPath();
  if (!sock) {
    fail(EXIT.NETWORK, tag, 'Engine not running.', 'Start with: ellul up');
  }
  return sock;
}

export async function engineCall(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<unknown> {
  const sockPath = requireEngine(method);

  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    const conn = net.createConnection(sockPath);
    let buf = '';
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('engine request timed out'));
    }, timeoutMs);

    conn.on('connect', () => {
      conn.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        clearTimeout(timer);
        const line = buf.slice(0, idx);
        conn.destroy();
        try {
          const resp = JSON.parse(line);
          if (resp.error) {
            reject(new Error(resp.error.message));
          } else {
            resolve(resp.result);
          }
        } catch {
          reject(new Error('invalid engine response'));
        }
      }
    });

    conn.on('error', (e) => {
      clearTimeout(timer);
      conn.destroy();
      reject(new Error(`engine connection failed: ${e.message}`));
    });
  });
}

export async function engineCallStreaming(
  method: string,
  params: Record<string, unknown>,
  onProgress: (msg: string) => void,
  timeoutMs = 600000,
): Promise<unknown> {
  const sockPath = requireEngine(method);

  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    const conn = net.createConnection(sockPath);
    let settled = false;
    const timer = setTimeout(() => {
      conn.destroy();
      if (!settled) { settled = true; reject(new Error('engine request timed out')); }
    }, timeoutMs);

    conn.on('connect', () => {
      conn.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    let buf = '';
    conn.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          if (resp.error) {
            clearTimeout(timer);
            conn.destroy();
            if (!settled) { settled = true; reject(new Error(resp.error.message)); }
            return;
          }
          if (resp.result?.done) {
            clearTimeout(timer);
            conn.destroy();
            if (!settled) { settled = true; resolve(resp.result); }
            return;
          }
          if (resp.result?.line != null) {
            onProgress(String(resp.result.line));
          }
        } catch {}
      }
    });

    conn.on('close', () => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(new Error('engine connection closed unexpectedly')); }
    });
    conn.on('error', (e) => {
      clearTimeout(timer);
      conn.destroy();
      if (!settled) { settled = true; reject(new Error(`engine connection failed: ${e.message}`)); }
    });
  });
}

export function streamEngineOutput(
  method: string,
  params: Record<string, unknown>,
  onLine: (line: string) => void,
  onEnd: () => void,
): () => void {
  const sockPath = requireEngine(method);
  const id = ++rpcId;
  const conn = net.createConnection(sockPath);

  conn.on('connect', () => {
    conn.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  let buf = '';
  conn.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const resp = JSON.parse(line);
        if (resp.error) {
          onLine(`[error] ${resp.error.message}`);
          conn.destroy();
          return;
        }
        if (resp.result?.line != null) {
          onLine(resp.result.line);
        }
      } catch {}
    }
  });

  conn.on('close', () => {
    if (buf.trim()) {
      try {
        const resp = JSON.parse(buf);
        if (resp.result?.line != null) onLine(resp.result.line);
      } catch {}
    }
    onEnd();
  });
  conn.on('error', () => onEnd());

  return () => conn.destroy();
}
