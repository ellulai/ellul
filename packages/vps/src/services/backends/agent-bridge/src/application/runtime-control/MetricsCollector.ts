// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { METRICS_PROMETHEUS_PORT } from "@vps/services/shared/ports";

export type Adapter = "claude" | "opencode" | "cursor" | "codex";

export interface CgroupKey {
  cgroupPath: string;
  slice: string;
  sandbox: string | null;
  adapter: Adapter | null;
  scope: string | null;
}

export interface CgroupSample {
  key: CgroupKey;
  at: number;
  memoryCurrentBytes: number;
  memoryHighBytes: number | null;
  memoryMaxBytes: number | null;
  memoryEvents: { low: number; high: number; max: number; oom: number; oomKill: number };
  psiMem: { avg10: number; avg60: number; avg300: number };
  cpuUsageUsec: number;
  cpuUserUsec: number;
  cpuSystemUsec: number;
  psiCpu: { avg10: number; avg60: number; avg300: number };
  pidsCurrent: number;
}

export type Listener = (samples: ReadonlyArray<CgroupSample>) => void;

export interface MetricsCollector {
  latest(cgroupPath: string): CgroupSample | null;
  snapshot(): ReadonlyArray<CgroupSample>;
  window(cgroupPath: string, lastSeconds: number): ReadonlyArray<CgroupSample>;
  subscribe(listener: Listener): () => void;
  stop(): Promise<void>;
}

export interface CollectorOptions {
  cgroupRoot?: string;
  intervalMs?: number;
  ringSize?: number;
  prometheusPort?: number | null;
  snapshotDir?: string | null;
  snapshotIntervalMs?: number;
  retainDays?: number;
  fs?: typeof fs;
  now?: () => number;
}

const DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup";

export function makeMetricsCollector(opts: CollectorOptions = {}): MetricsCollector {
  const root = opts.cgroupRoot ?? DEFAULT_CGROUP_ROOT;
  const intervalMs = opts.intervalMs ?? 1000;
  const ringSize = opts.ringSize ?? 3600;
  const fsImpl = opts.fs ?? fs;
  const now = opts.now ?? Date.now;
  const promPort = opts.prometheusPort === undefined ? METRICS_PROMETHEUS_PORT : opts.prometheusPort;
  const snapshotDir = opts.snapshotDir === undefined ? "/var/log/ellul/metrics" : opts.snapshotDir;
  const snapshotIntervalMs = opts.snapshotIntervalMs ?? 60_000;
  const retainDays = opts.retainDays ?? 7;

  const buffers = new Map<string, CgroupSample[]>();
  const listeners = new Set<Listener>();
  let timer: NodeJS.Timeout | null = null;
  let snapshotTimer: NodeJS.Timeout | null = null;
  let promServer: http.Server | null = null;
  let stopped = false;

  function appendSample(s: CgroupSample): void {
    let buf = buffers.get(s.key.cgroupPath);
    if (!buf) {
      buf = [];
      buffers.set(s.key.cgroupPath, buf);
    }
    buf.push(s);
    if (buf.length > ringSize) buf.shift();
  }

  function tick(): void {
    const keys = discoverCgroups(root, fsImpl);
    const samples: CgroupSample[] = [];
    const at = now();
    for (const key of keys) {
      const s = readSample(root, key, at, fsImpl);
      if (s) {
        appendSample(s);
        samples.push(s);
      }
    }
    for (const ks of [...buffers.keys()]) {
      if (!keys.find((k) => k.cgroupPath === ks)) buffers.delete(ks);
    }
    for (const l of listeners) {
      try { l(samples); } catch { /* listener errors are not fatal */ }
    }
  }

  function start(): void {
    const jitter = () => Math.max(1, intervalMs + (Math.random() * 100 - 50));
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        try { tick(); } catch { /* sampler errors are not fatal */ }
        schedule();
      }, jitter());
    };
    schedule();

    if (snapshotDir) {
      try { fsImpl.mkdirSync(snapshotDir, { recursive: true }); } catch { /* dir may already exist or permission denied */ }
      snapshotTimer = setInterval(() => writeSnapshot(snapshotDir, buffers, fsImpl, retainDays).catch(() => {}), snapshotIntervalMs);
    }

    if (promPort !== null) {
      promServer = http.createServer((req, res) => {
        if (req.url !== "/metrics") { res.statusCode = 404; res.end(); return; }
        res.setHeader("content-type", "text/plain; version=0.1.0");
        res.end(renderPrometheus(snapshotAll()));
      });
      promServer.listen(promPort, "127.0.0.1");
    }
  }

  function snapshotAll(): CgroupSample[] {
    const out: CgroupSample[] = [];
    for (const buf of buffers.values()) if (buf.length) out.push(buf[buf.length - 1]!);
    return out;
  }

  start();

  return {
    latest(p) { const buf = buffers.get(p); return buf && buf.length ? buf[buf.length - 1]! : null; },
    snapshot() { return snapshotAll(); },
    window(p, lastSeconds) {
      const buf = buffers.get(p);
      if (!buf) return [];
      const cutoff = now() - lastSeconds * 1000;
      return buf.filter((s) => s.at >= cutoff);
    },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (snapshotTimer) clearInterval(snapshotTimer);
      if (promServer) await new Promise<void>((r) => promServer!.close(() => r()));
    },
  };
}

const SBX_RE = /ellul-user-workload-sbx-([a-z0-9]{7})\.slice/;
const POOL_RE = /ellul-pool-sbx-([a-z0-9]{7})-(claude|opencode|cursor|codex)-([a-zA-Z0-9_-]{1,32})\.scope/;
const PRO_SLOT_RE = /ellul-pro-claude-slot[1-9]\.scope/;

export function deriveKey(cgroupPath: string): CgroupKey {
  const segments = cgroupPath.split("/").filter(Boolean);
  const last = segments[segments.length - 1]!;
  const slice = segments.find((s) => s.endsWith(".slice")) ?? last;
  let sandbox: string | null = null;
  let adapter: Adapter | null = null;
  let scope: string | null = null;
  for (const seg of segments) {
    const sbxMatch = SBX_RE.exec(seg);
    if (sbxMatch) sandbox = `sbx-${sbxMatch[1]!}`;
    const poolMatch = POOL_RE.exec(seg);
    if (poolMatch) {
      sandbox = `sbx-${poolMatch[1]!}`;
      adapter = poolMatch[2] as Adapter;
      scope = poolMatch[3]!;
    }
    if (PRO_SLOT_RE.test(seg)) {
      adapter = "claude";
      scope = seg.replace(/\.scope$/, "");
    }
  }
  return { cgroupPath, slice, sandbox, adapter, scope };
}

const KNOWN_PARENTS = [
  "ellul-control-plane.slice",
  "ellul-user-workload.slice",
  "ellul-namespaces.slice",
];

export function discoverCgroups(root: string, fsImpl: typeof fs = fs): CgroupKey[] {
  const out: CgroupKey[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    let isCgroup = false;
    try { fsImpl.accessSync(path.join(dir, "cgroup.controllers")); isCgroup = true; } catch { /* not a cgroup */ }
    if (isCgroup && dir !== root) {
      const rel = path.relative(root, dir);
      out.push(deriveKey(rel));
    }
    for (const e of entries) {
      if (e.isDirectory()) visit(path.join(dir, e.name));
    }
  };
  for (const parent of KNOWN_PARENTS) {
    const p = path.join(root, parent);
    try { fsImpl.accessSync(p); } catch { continue; }
    visit(p);
  }
  return out;
}

function readSample(root: string, key: CgroupKey, at: number, fsImpl: typeof fs): CgroupSample | null {
  const dir = path.join(root, key.cgroupPath);
  const memoryCurrentBytes = readNum(path.join(dir, "memory.current"), fsImpl);
  if (memoryCurrentBytes === null) return null;
  return {
    key,
    at,
    memoryCurrentBytes,
    memoryHighBytes: readNumOrMax(path.join(dir, "memory.high"), fsImpl),
    memoryMaxBytes: readNumOrMax(path.join(dir, "memory.max"), fsImpl),
    memoryEvents: readMemoryEvents(path.join(dir, "memory.events"), fsImpl),
    psiMem: readPsi(path.join(dir, "memory.pressure"), fsImpl),
    cpuUsageUsec: readCpuField(path.join(dir, "cpu.stat"), "usage_usec", fsImpl),
    cpuUserUsec: readCpuField(path.join(dir, "cpu.stat"), "user_usec", fsImpl),
    cpuSystemUsec: readCpuField(path.join(dir, "cpu.stat"), "system_usec", fsImpl),
    psiCpu: readPsi(path.join(dir, "cpu.pressure"), fsImpl),
    pidsCurrent: readNum(path.join(dir, "pids.current"), fsImpl) ?? 0,
  };
}

function readNum(p: string, fsImpl: typeof fs): number | null {
  try {
    const v = parseInt(fsImpl.readFileSync(p, "utf8").trim(), 10);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

function readNumOrMax(p: string, fsImpl: typeof fs): number | null {
  try {
    const raw = fsImpl.readFileSync(p, "utf8").trim();
    if (raw === "max") return null;
    const v = parseInt(raw, 10);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

function readMemoryEvents(p: string, fsImpl: typeof fs): CgroupSample["memoryEvents"] {
  const empty = { low: 0, high: 0, max: 0, oom: 0, oomKill: 0 };
  try {
    const lines = fsImpl.readFileSync(p, "utf8").trim().split("\n");
    const out = { ...empty };
    for (const l of lines) {
      const [k, v] = l.split(/\s+/);
      const n = parseInt(v ?? "0", 10);
      if (k === "low") out.low = n;
      else if (k === "high") out.high = n;
      else if (k === "max") out.max = n;
      else if (k === "oom") out.oom = n;
      else if (k === "oom_kill") out.oomKill = n;
    }
    return out;
  } catch { return empty; }
}

const PSI_RE = /some\s+avg10=([0-9.]+)\s+avg60=([0-9.]+)\s+avg300=([0-9.]+)/;
function readPsi(p: string, fsImpl: typeof fs): { avg10: number; avg60: number; avg300: number } {
  const empty = { avg10: 0, avg60: 0, avg300: 0 };
  try {
    const m = PSI_RE.exec(fsImpl.readFileSync(p, "utf8"));
    if (!m) return empty;
    return { avg10: parseFloat(m[1]!), avg60: parseFloat(m[2]!), avg300: parseFloat(m[3]!) };
  } catch { return empty; }
}

function readCpuField(p: string, field: string, fsImpl: typeof fs): number {
  try {
    const lines = fsImpl.readFileSync(p, "utf8").trim().split("\n");
    for (const l of lines) {
      const [k, v] = l.split(/\s+/);
      if (k === field) {
        const n = parseInt(v ?? "0", 10);
        return Number.isFinite(n) ? n : 0;
      }
    }
    return 0;
  } catch { return 0; }
}

export function renderPrometheus(samples: ReadonlyArray<CgroupSample>): string {
  const lines: string[] = [];
  const help = (name: string, desc: string, type: string) => {
    lines.push(`# HELP ${name} ${desc}`);
    lines.push(`# TYPE ${name} ${type}`);
  };
  const labels = (k: CgroupKey) =>
    `slice="${escape(k.slice)}",sandbox="${escape(k.sandbox ?? "")}",adapter="${escape(k.adapter ?? "")}",scope="${escape(k.scope ?? "")}"`;

  help("ellul_cgroup_memory_current_bytes", "Current memory.current per cgroup, bytes.", "gauge");
  for (const s of samples) lines.push(`ellul_cgroup_memory_current_bytes{${labels(s.key)}} ${s.memoryCurrentBytes}`);

  help("ellul_cgroup_memory_high_bytes", "Configured memory.high per cgroup, bytes (max → -1).", "gauge");
  for (const s of samples) lines.push(`ellul_cgroup_memory_high_bytes{${labels(s.key)}} ${s.memoryHighBytes ?? -1}`);

  help("ellul_cgroup_memory_max_bytes", "Configured memory.max per cgroup, bytes (max → -1).", "gauge");
  for (const s of samples) lines.push(`ellul_cgroup_memory_max_bytes{${labels(s.key)}} ${s.memoryMaxBytes ?? -1}`);

  help("ellul_cgroup_psi_memory_avg10", "PSI memory avg10 per cgroup, percent.", "gauge");
  for (const s of samples) lines.push(`ellul_cgroup_psi_memory_avg10{${labels(s.key)}} ${s.psiMem.avg10}`);

  help("ellul_cgroup_psi_memory_avg60", "PSI memory avg60 per cgroup, percent.", "gauge");
  for (const s of samples) lines.push(`ellul_cgroup_psi_memory_avg60{${labels(s.key)}} ${s.psiMem.avg60}`);

  help("ellul_cgroup_cpu_usage_usec_total", "cpu.stat usage_usec per cgroup.", "counter");
  for (const s of samples) lines.push(`ellul_cgroup_cpu_usage_usec_total{${labels(s.key)}} ${s.cpuUsageUsec}`);

  help("ellul_cgroup_oom_events_total", "memory.events oom_kill counter per cgroup.", "counter");
  for (const s of samples) lines.push(`ellul_cgroup_oom_events_total{${labels(s.key)}} ${s.memoryEvents.oomKill}`);

  help("ellul_cgroup_pids_current", "pids.current per cgroup.", "gauge");
  for (const s of samples) lines.push(`ellul_cgroup_pids_current{${labels(s.key)}} ${s.pidsCurrent}`);

  return lines.join("\n") + "\n";
}

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

async function writeSnapshot(
  dir: string,
  buffers: Map<string, CgroupSample[]>,
  fsImpl: typeof fs,
  retainDays: number,
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${day}.jsonl`);
  const tail: string[] = [];
  for (const buf of buffers.values()) {
    const s = buf[buf.length - 1];
    if (s) tail.push(JSON.stringify(s));
  }
  if (tail.length === 0) return;
  fsImpl.appendFileSync(file, tail.join("\n") + "\n");

  const cutoff = Date.now() - retainDays * 86_400_000;
  let entries: fs.Dirent[] = [];
  try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    let st: fs.Stats;
    try { st = fsImpl.statSync(full); } catch { continue; }
    if (st.mtimeMs < cutoff) {
      try { fsImpl.unlinkSync(full); } catch { /* may have been rotated already */ }
    } else if (e.name.endsWith(".jsonl") && Date.now() - st.mtimeMs > 86_400_000) {
      const gz = `${full}.gz`;
      try {
        await pipeline(fsImpl.createReadStream(full), createGzip(), fsImpl.createWriteStream(gz));
        fsImpl.unlinkSync(full);
      } catch { /* gzip best-effort */ }
    }
  }
}
