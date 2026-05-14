// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { GBRAIN_PORT } from '../../shared/ports';

const GBRAIN_DIR = '/opt/ellul/gbrain';
const GBRAIN_CONFIG_DIR = '/etc/ellul/gbrain';

/**
 * Generate the systemd service unit for ellul-gbrain.
 *
 * gbrain is a Bun-based MCP server (Postgres + pgvector). It runs as
 * root in the top-level ellul.slice (NOT control-plane — avoids
 * cgroup memory pressure on bridge/shield). Listens 127.0.0.1:7704.
 * Unreachable from agent namespaces — only the agent-bridge MCP
 * gateway connects via streamable-http.
 */
export function getGbrainService(heapCapMb: number = 192): string {
  return `[Unit]
Description=ellul gbrain — persistent agent memory (MCP)
After=network-online.target local-fs.target postgresql.service ellul-sovereign-shield.service
Wants=network-online.target
Requires=postgresql.service
RequiresMountsFor=/etc/ellul /opt/ellul

[Service]
Type=simple
Slice=ellul.slice
User=root
Group=root
WorkingDirectory=${GBRAIN_DIR}
ExecStart=/usr/local/bin/bun run ${GBRAIN_DIR}/src/cli.ts serve --http --port ${GBRAIN_PORT} --host 127.0.0.1
StandardOutput=append:${GBRAIN_CONFIG_DIR}/service.log
StandardError=append:${GBRAIN_CONFIG_DIR}/service.log
Restart=on-failure
RestartSec=10
EnvironmentFile=-${GBRAIN_CONFIG_DIR}/env
Environment=NODE_ENV=production
MemoryHigh=${Math.round(heapCapMb * 0.85)}M
MemoryMax=${heapCapMb}M
MemorySwapMax=0
ProtectSystem=strict
PrivateTmp=true
ReadWritePaths=${GBRAIN_CONFIG_DIR} ${GBRAIN_DIR} /root
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LimitCORE=0
TasksMax=64

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Compute gbrain heap cap from physical RAM.
 * Only called for 8 GB+ tiers (gbrain is unavailable below that).
 */
export function computeGbrainHeapCap(totalRamMb: number): number {
  if (totalRamMb <= 8192) return 192;
  if (totalRamMb <= 16384) return 256;
  return 384;
}
