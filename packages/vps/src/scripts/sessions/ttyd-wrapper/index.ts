// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import content from '@vps/shell/sessions/ttyd-wrapper.sh';

/**
 * ttyd wrapper script - maps session names to ports and launches ttyd.
 */
export function getTtydWrapperScript(): string {
  return content;
}

/**
 * ttyd systemd service template.
 * @param svcUser - Service user name (coder for free tier, dev for paid)
 */
export function getTtydSystemdTemplate(svcUser: string = "dev"): string {
  const svcHome = `/home/${svcUser}`;
  return `[Unit]
Description=ttyd - Terminal Session %i
After=network.target

[Service]
Type=simple
User=${svcUser}
Group=${svcUser}
WorkingDirectory=${svcHome}/projects
ExecStart=/usr/local/bin/ellul-ttyd-wrapper %i
ExecStop=/usr/bin/tmux kill-session -t %i
ExecStopPost=/bin/bash -c 'pkill -f "ellul-launch %i" 2>/dev/null || true'
# Restart on real failures only — not on clean SIGTERM (user closed it)
# and not in a tight loop (StartLimit caps churn).
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=SIGTERM
StartLimitBurst=3
StartLimitIntervalSec=120
# Memory cap per ttyd session. A runaway shell, a fork bomb, or a heavy
# command (htop + watch + many tmux panes) can't starve the host.
# cgroup OOMs only this unit on breach.
MemoryMax=128M
# When global memory pressure hits, the kernel picks high-oom_score
# processes first. ttyd shells are user content — kill them BEFORE
# the control plane (which sits at OOMScoreAdjust=-1000).
OOMScoreAdjust=500

[Install]
WantedBy=multi-user.target`;
}
