<!-- SPDX-License-Identifier: MIT -->

# ellul Console

The open-source dashboard for ellul cloud development workspaces.

## Overview

The console is a Next.js application that serves as the primary interface for managing cloud development sandboxes. It provides:

- **AI-Powered Workspace** -- Chat with AI agents that build, iterate, and deploy code inside isolated cloud sandboxes. Browse and edit project files alongside a live preview of your running application.
- **Integrations Hub** -- Connect source control (GitHub, GitLab, Bitbucket), deploy targets (Vercel, Cloudflare Workers), data providers (Supabase, Neon), and AI agent configurations from a single pane.
- **Database Tools** -- Browse tables, run SQL queries, manage backups, and execute migrations through a gated security model.
- **Vault** -- Persistent notes with a knowledge graph and scoped access control.
- **Observability** -- Server health metrics, gate audit trails, development and production logs, and AI agent session monitoring.
- **Security Settings** -- Three-tier security progression (Standard, Web Lock, Privacy Lock) with passkey authentication and optional encrypted volumes.

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 10+

### Install

```bash
# From the repository root
pnpm install
```

### Environment Variables

Create a `.env.local` in `apps/console/`:

```bash
NEXT_PUBLIC_API_URL=http://localhost:3001   # ellul API endpoint
NEXT_PUBLIC_WEB_URL=http://localhost:3000   # Console URL (self)
```

### Run

```bash
# From the repository root (starts all packages via Turborepo)
pnpm dev

# Or run the console alone
pnpm --filter @ellul.ai/console dev
```

The console starts at `http://localhost:3000` with Turbopack for fast refresh.

### Demo Mode (No Backend Required)

Contributors can run the full console UI with realistic mock data — no backend, no VPS, no domains needed:

```bash
NEXT_PUBLIC_MOCK_MODE=true pnpm --filter @ellul.ai/console dev
```

This enables:
- Mock authentication (auto-logged-in as demo user)
- Realistic server, app, and integration data
- All UI interactions work (tab switching, workspace customization, actions)
- API calls intercepted with mock responses
- Database browser with sample tables and query results
- Deploy history with success and error examples
- Connected git and deploy provider cards

Demo mode is the recommended way to develop UI components. All fetch calls are intercepted by `src/lib/mock-fetch.ts` — add new mock routes there when building features that call new API endpoints.

A subtle "Demo Mode" banner appears at the top of the dashboard to distinguish it from production.

### Test

```bash
pnpm --filter @ellul.ai/console exec vitest run
```

## Architecture

The console is organized around six top-level contexts, each backed by the workspace extension system:

```
Dashboard Shell
  |
  +-- Workspace
  |     +-- Chat          (AI chat interface)
  |     +-- Code          (file browser / editor)
  |     +-- Preview       (live dev server preview)
  |
  +-- Integrations
  |     +-- Source Control (GitHub / GitLab / Bitbucket)
  |     +-- Deploy        (Vercel / Cloudflare Workers)
  |     +-- Data          (Supabase / Neon / custom DB)
  |     +-- AI Agents     (provider keys, channels, core files)
  |
  +-- Database
  |     +-- Tables / SQL / Bin / Settings
  |
  +-- Vault
  |     +-- Notes / Graph / Scopes
  |
  +-- Observability
  |     +-- Health / Gates / Development / Production / ZeroClaw
  |
  +-- Settings
        +-- Context / Secrets / Security / Migrations
```

Navigation state is URL-driven via `useDashboardNav` -- every context and tab maps to query parameters (`?ctx=workspace&tab=chat`), enabling deep linking and browser history support.

See [docs/v2/architecture/00-system-overview.md](../../docs/v2/architecture/00-system-overview.md) for the full technical deep-dive.

## Workspace Extension System

All tabs in the console are declared through a manifest-based extension system:

1. **Manifest Registry** (`workspace-extensions.ts`) -- Pure data declarations for every tab: ID, context, route segment, product requirements, and display metadata.
2. **Runtime Binding Registry** (`workspace-extension-registry.ts`) -- Maps extension/tab IDs to React components and icons at runtime. Missing bindings degrade gracefully.
3. **Resolver Pipeline** (`resolve-workspace-state.ts`) -- An 11-step pure function that transforms raw config into a fully resolved, gated, and repaired workspace state.
4. **Presets** (`workspace-presets.ts`) -- Named tab configurations (Developer, Developer + Preview, Researcher, Writer, Full) that expand into complete configs.
5. **Per-Sandbox Config** -- Each sandbox stores its own `WorkspaceConfigV1` in the database, enabling per-project customization with a preset picker in the creation flow.

## Dynamic Actions

Contextual actions (Deploy, Push, DB Push, Backup, etc.) appear automatically based on integration state. The system uses a pure resolver:

```
IntegrationState + ActionContext --> resolveActions() --> ResolvedAction[]
```

Actions are categorized by severity (normal, warning, destructive) and integrate with the gate system for agent-initiated operations. The `ContextActions` component renders available actions inline wherever the user is working.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router, Turbopack, React Compiler) |
| UI | React 19, Tailwind CSS, Radix UI primitives |
| Data | TanStack Query, Hono RPC client, Server-Sent Events |
| Auth | better-auth, WebAuthn / passkeys, proof-of-possession tokens |
| Deployment | Cloudflare Workers via OpenNext |
| Testing | Vitest |
| Monorepo | Turborepo, pnpm workspaces |

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for development setup, code style, and PR guidelines.

## License

[MIT](LICENSE) -- Copyright (c) 2025-present ellul.ai
