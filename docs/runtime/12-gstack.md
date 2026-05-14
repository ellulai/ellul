# gstack — AI Coding Agent Skill Pack

gstack (by Garry Tan) is a skill pack for AI coding agents. 30+ skills that teach agents structured workflows: `/qa`, `/review`, `/ship`, `/investigate`, `/browse`, `/office-hours`, and more. Works with Claude Code, Codex, Kiro, and Factory.

Source: `/opt/ellul/gstack/` (git clone from github.com/garrytan/gstack).

## Availability

- **All tiers.** Pre-installed on disk at provisioning for all cloud_platform profiles.
- **Default OFF.** User opts in via console toggle (AI Tools card).
- Skills stay unlinked until toggled on — agent CLIs cannot discover them.

## What It Is

gstack skills are fat markdown files (`SKILL.md`) that Claude Code (and other CLIs) read at runtime. Each skill encodes a complete workflow: how to review code, run QA, investigate a bug, ship a feature. The agent reads the skill, follows the steps, and uses tools like the browse binary (headless Chromium) for visual testing.

No daemon. No port. No RAM cost. ~310 MB disk (mostly Playwright Chromium).

## Key Skills

| Skill | What it does |
| --- | --- |
| `/qa` | Run QA testing against the dev server |
| `/review` | Code review with checklists |
| `/ship` | Ship a PR end-to-end |
| `/investigate` | Root-cause analysis for bugs |
| `/browse` | Headless browser for visual testing |
| `/office-hours` | YC-style product brainstorming |
| `/cso` | Security audit |
| `/design-review` | Visual design critique |
| `/codex` | Cross-model second opinion |

## Installation on VPS

**Pre-install** (provisioning, gated on `profile.packages.gstack`):
1. Clone gstack to `/opt/ellul/gstack/` (depth 1)
2. `bun install` (Playwright + browse binary dependencies)
3. `bun run build` (compile browse binary, ~104 MB)
4. `bunx playwright install chromium`

**Activation** (runtime, when user toggles ON):
```bash
cd /opt/ellul/gstack
./setup --host auto --no-prefix
```

This creates skill symlinks for all detected agent CLIs:
- `$SVC_HOME/.claude/skills/gstack/` + per-skill symlinks
- `$SVC_HOME/.codex/skills/gstack/` + per-skill symlinks

**Deactivation** (when user toggles OFF):
Remove skill symlinks from `$SVC_HOME/.claude/skills/` and `$SVC_HOME/.codex/skills/`.

## Key Paths

| Path | Purpose |
| --- | --- |
| `/opt/ellul/gstack/` | gstack repo (shared source) |
| `/opt/ellul/gstack/browse/dist/browse` | Browse binary (headless Chromium wrapper) |
| `/opt/ellul/gstack/bin/` | gstack CLI utilities |
| `$SVC_HOME/.claude/skills/gstack/` | Claude Code skill discovery (symlink) |
| `$SVC_HOME/.codex/skills/gstack/` | Codex skill discovery (symlink) |
| `$SVC_HOME/.gstack/` | gstack state (analytics, sessions, projects) |

## Namespace Considerations

gstack skills execute inside the agent's namespace (Claude Code is already namespaced). The browse binary at `/opt/ellul/gstack/browse/dist/browse` needs to launch Chromium. The `/opt/ellul/` tree must be readable from within namespaces.

## Enable / Disable Flow

1. User toggles gstack ON in console AI Tools card
2. API updates `servers.gstack_enabled`, enqueues `update-features` command
3. Enforcer claims command, runs gstack setup to create skill symlinks
4. Next Claude Code / Codex session discovers skills automatically

Disable: enforcer removes skill symlinks. Existing sessions keep their loaded skills until the session ends.

State persisted in `/etc/ellul/features.json` for reboot survival.

## Updates

Enforcer checks manifest version on heartbeat. When a new gstack version is detected:
1. `git pull` in `/opt/ellul/gstack/`
2. `bun run build` if sources changed (rebuild browse binary)
3. Skill symlinks auto-update (they point into the repo)
