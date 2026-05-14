#!/usr/bin/env node
// ellul.ai MCP Stdio-to-HTTP Relay
// Bridges MCP stdio transport (stdin/stdout) to the agent-bridge MCP HTTP endpoint.
// Spawned by OpenCode/Claude Code/Codex via .mcp.json discovery.
// Environment: ELLUL_MCP_URL, ELLUL_MCP_TOKEN, ELLUL_MCP_PROJECT

'use strict';

const http = require('http');
const https = require('https');

const MCP_URL = process.env.ELLUL_MCP_URL;
const MCP_TOKEN = process.env.ELLUL_MCP_TOKEN;
const MCP_PROJECT = process.env.ELLUL_MCP_PROJECT;

if (!MCP_URL || !MCP_TOKEN || !MCP_PROJECT) {
  process.stderr.write('FATAL: Missing ELLUL_MCP_URL, ELLUL_MCP_TOKEN, or ELLUL_MCP_PROJECT\n');
  process.exit(1);
}

const parsedUrl = new URL(MCP_URL);
const transport = parsedUrl.protocol === 'https:' ? https : http;

// ── Dual-Format Stdin Reader ──
// Supports BOTH MCP stdio formats:
//   1. Newline-delimited JSON (MCP spec: one JSON object per line, \n terminated)
//   2. Content-Length framing (LSP-style: "Content-Length: N\r\n\r\n{...}")
// OpenCode (Bun-based) uses Content-Length framing; Claude Code uses newline-delimited.
// We auto-detect the format from the first bytes.

let inputBuffer = Buffer.alloc(0);
let detectedFormat = null; // 'newline' | 'content-length'
let pendingInflight = 0;

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk]);
  processBuffer();
});

process.stdin.on('end', () => {
  if (pendingInflight === 0) process.exit(0);
  // Defer exit until all inflight requests complete
});

function processBuffer() {
  while (inputBuffer.length > 0) {
    if (!detectedFormat) {
      // Auto-detect: Content-Length framing starts with 'C' (0x43), newline JSON starts with '{' (0x7b)
      // Skip any leading whitespace/newlines
      let firstNonWs = 0;
      while (firstNonWs < inputBuffer.length && (inputBuffer[firstNonWs] === 0x0a || inputBuffer[firstNonWs] === 0x0d || inputBuffer[firstNonWs] === 0x20)) {
        firstNonWs++;
      }
      if (firstNonWs >= inputBuffer.length) {
        inputBuffer = Buffer.alloc(0);
        return;
      }
      if (firstNonWs > 0) inputBuffer = inputBuffer.subarray(firstNonWs);
      const firstByte = inputBuffer[0];
      if (firstByte === 0x43) { // 'C' — Content-Length header
        detectedFormat = 'content-length';
      } else {
        detectedFormat = 'newline';
      }
    }

    if (detectedFormat === 'content-length') {
      if (!tryReadContentLength()) return;
    } else {
      if (!tryReadNewline()) return;
    }
  }
}

function tryReadContentLength() {
  const headerEnd = bufferIndexOf(inputBuffer, '\r\n\r\n');
  if (headerEnd === -1) return false;

  const headerStr = inputBuffer.subarray(0, headerEnd).toString('utf8');
  const match = headerStr.match(/Content-Length:\s*(\d+)/i);
  if (!match) {
    // Malformed header — skip to after the double CRLF and retry
    inputBuffer = inputBuffer.subarray(headerEnd + 4);
    return true;
  }

  const contentLength = parseInt(match[1], 10);
  const bodyStart = headerEnd + 4;
  if (inputBuffer.length < bodyStart + contentLength) return false; // need more data

  const body = inputBuffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8');
  inputBuffer = inputBuffer.subarray(bodyStart + contentLength);

  if (body.trim()) handleMessage(body);
  return true;
}

function tryReadNewline() {
  const str = inputBuffer.toString('utf8');
  const nl = str.indexOf('\n');
  if (nl === -1) return false;

  const line = str.slice(0, nl).replace(/\r$/, '');
  inputBuffer = Buffer.from(str.slice(nl + 1), 'utf8');

  if (line.trim()) handleMessage(line);
  return true;
}

function bufferIndexOf(buf, needle) {
  const needleBuf = Buffer.from(needle, 'utf8');
  for (let i = 0; i <= buf.length - needleBuf.length; i++) {
    let found = true;
    for (let j = 0; j < needleBuf.length; j++) {
      if (buf[i + j] !== needleBuf[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

function handleMessage(jsonStr) {
  let msg;
  try {
    msg = JSON.parse(jsonStr);
  } catch (e) {
    writeError(null, -32700, 'Parse error');
    return;
  }

  // Notifications (no id) — fire-and-forget, no response expected
  if (msg.id === undefined || msg.id === null) {
    forwardToEndpoint(jsonStr).catch(() => {});
    return;
  }

  pendingInflight++;
  forwardToEndpoint(jsonStr)
    .then((response) => writeResponse(response))
    .catch((err) => {
      writeError(msg.id, -32000, 'Relay error: ' + (err && err.message ? err.message : 'unknown'));
    })
    .finally(() => {
      pendingInflight--;
      if (pendingInflight === 0 && !process.stdin.readable) process.exit(0);
    });
}

function forwardToEndpoint(body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(body, 'utf8');
    const req = transport.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + MCP_TOKEN,
          'x-mcp-project': MCP_PROJECT,
          'Content-Length': bodyBuf.length,
        },
        timeout: 60000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 204) {
            resolve(null);
            return;
          }
          const responseBody = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error('HTTP ' + res.statusCode + ': ' + responseBody.slice(0, 200)));
            return;
          }
          resolve(responseBody);
        });
      },
    );
    req.on('socket', (socket) => {
      if (!socket.connecting) return;
      const connectTimer = setTimeout(() => {
        req.destroy(new Error('Connect timeout (5s)'));
      }, 5000);
      socket.once('connect', () => clearTimeout(connectTimer));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(bodyBuf);
    req.end();
  });
}

function writeResponse(body) {
  if (!body) return;
  const singleLine = body.replace(/[\r\n]+/g, ' ');
  // Respond in the same format the client uses
  if (detectedFormat === 'content-length') {
    const encoded = Buffer.from(singleLine, 'utf8');
    process.stdout.write('Content-Length: ' + encoded.length + '\r\n\r\n');
    process.stdout.write(encoded);
  } else {
    process.stdout.write(singleLine + '\n');
  }
}

function writeError(id, code, message) {
  const err = JSON.stringify({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
  writeResponse(err);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
