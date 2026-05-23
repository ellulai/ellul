// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Platform abstraction for preview lifecycle.
//
// Linux/VPS: systemd units, ss socket inspection, cgroup monitoring.
// Android/PRoot: direct child_process spawn, process Map, net.Socket probes.
//
// Every preview caller imports `previewPlatform` from this file. No
// scattered IS_ANDROID checks anywhere else in the preview subsystem.

import { PLATFORM } from '@vps/shared/platform';

// ── Types ────────────────────────────────────────────────────────────

export interface UnitStatus {
  ActiveState: string;
  SubState: string;
  Result: string;
  ExecMainStatus: string;
  ActiveEnterTimestampMonotonic: number;
}

export interface UnitResult {
  ok: boolean;
  error?: string;
}

export interface FailedUnit {
  instance: string;
  result: string;
}

export interface FrameworkDropinOpts {
  memoryHighMB: number | null;
  memoryMaxMB: number | null;
  tasksMax: number | null;
  cpuQuotaPercent: number | null;
}

// ── Interface ────────────────────────────────────────────────────────

export interface PreviewPlatform {
  // Unit lifecycle
  startUnit(appDir: string): Promise<UnitResult>;
  stopUnit(appDir: string, opts?: { mode?: 'graceful' | 'immediate' }): Promise<UnitResult>;
  restartUnit(appDir: string): Promise<UnitResult>;
  resetFailed(appDir: string): Promise<void>;
  isActive(appDir: string): Promise<boolean>;
  unitStatus(appDir: string): Promise<UnitStatus>;
  listActive(): Promise<string[]>;

  // Cgroup resource caps
  writeFrameworkDropin(appDir: string, opts: FrameworkDropinOpts): Promise<UnitResult>;
  clearFrameworkDropin(appDir: string): Promise<UnitResult>;

  // Socket / port inspection
  getPidOnPort(port: number): number | null;
  countEstablishedConnections(port: number): number;
  detectMismatchedPort(appDirectory: string, expectedPort: number): number | null;

  // Journal / logs
  readJournalTail(appDirectory: string, lines?: number): Promise<string>;

  // Failed unit cleanup
  listFailedUnits(): FailedUnit[];

  // Instance naming (systemd escaping on Linux, identity on Android)
  escapeInstance(appDir: string): string;

  // Capabilities
  readonly hasCgroups: boolean;
  readonly hasConnectionCounting: boolean;
  readonly hasPortScanning: boolean;
}

// ── Factory ──────────────────────────────────────────────────────────

function createPreviewPlatform(): PreviewPlatform {
  if (PLATFORM === 'android') {
    const { AndroidPreviewPlatform } = require('./PreviewPlatformAndroid') as typeof import('./PreviewPlatformAndroid');
    return new AndroidPreviewPlatform();
  }
  const { LinuxPreviewPlatform } = require('./PreviewPlatformLinux') as typeof import('./PreviewPlatformLinux');
  return new LinuxPreviewPlatform();
}

export const previewPlatform: PreviewPlatform = createPreviewPlatform();
