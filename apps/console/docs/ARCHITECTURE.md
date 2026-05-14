<!-- SPDX-License-Identifier: MIT -->

# Console Architecture

## Overview

The ellul console is a Next.js 15 application that serves as the UI for cloud development workspaces. It communicates with the platform API (HTTP) and individual VPS instances (WebSocket via bridge).

## Component Hierarchy

```
layout.tsx (auth, server status, providers)
  DashboardProviders (realtime, VPS bridge, code token, apps list)
    MobileDashboardLayout (navigation, tab management, content routing)
      DesktopHeader / MobileBottomNav (tab bars)
      WorkspaceContent (Chat, Code, Preview)
      ContextContent (Vault, Integrations, Database, Observability, Settings)
```

## Workspace Extension System

The console uses a plugin-based workspace shell where tabs are contributed by extensions.

### Layers

1. **Extension Manifests** (`workspace-extensions.ts`) — Declarative, serializable metadata. Each extension contributes one or more tabs to a context. Namespaced IDs (e.g. `core.chat`, `core.preview`).

2. **Manifest Registry** — Stores and indexes extensions. Enforces `routeSegment` uniqueness per context.

3. **Runtime Binding Registry** (`workspace-extension-registry.ts`) — Maps extension/tab IDs to React components and icons. Separate from manifests to keep metadata serializable.

4. **Config Schema** — `WorkspaceConfigV1` stored per-sandbox in `sandbox_workspace_configs` table. Versioned, revision-tracked for optimistic concurrency.

5. **Resolver** (`resolve-workspace-state.ts`) — Pure, deterministic function. Takes raw config + product + context and produces resolved tabs, available tabs, active tab fallback, and diagnostics. 10-step pipeline: expand null, migrate, replace deprecated, remove unknowns, inject required, canonicalize, apply gating, compute active/default, ensure viability, compute available.

6. **Runtime Mode Derivation** (`derive-runtime-mode.ts`) — Computes `"base"` or `"preview"` from the active tab. Only the active tab (or `backgroundRuntime: true` tabs) contribute modes.

7. **Presets** (`workspace-presets.ts`) — Named configurations (Developer, Developer+Preview, Researcher, Writer, Full). Applied during sandbox creation. Forward-compatible: missing contexts filled from registry defaults.

### Data Flow

```
User creates sandbox → picks preset → config stored in DB
  ↓
useWorkspaceConfig hook → fetches per-sandbox config from API
  ↓
resolveWorkspaceState() → produces ResolvedWorkspaceState
  ↓
useDashboardNav(tabOverrides) → URL validation uses resolved tabs
  ↓
Tab bar renders resolved tabs → + button opens TabAddMenu modal
```

## Navigation

URL search params are the single source of truth for transient navigation:

- `?ctx=workspace` — active context
- `?tab=chat` — active tab within context
- `?rp=preview` — desktop right panel (studio mode)

`useDashboardNav` hook manages this state with microtask-batched URL updates.

## Integrations

The Integrations context is the single source of truth for all external service connections.

| Tab | What it manages |
|-----|----------------|
| Source Control | GitHub, GitLab, Bitbucket OAuth + per-app repos |
| Deploy | Vercel, CF Workers OAuth + per-app deploy config |
| Data | Supabase, Neon, custom URL + per-app databases |
| AI Agents | Provider API keys, channels, core files |

## Dynamic Actions

Actions are contextual buttons derived from integration state.

```
useIntegrationState() → IntegrationState
  ↓
resolveActions(integrations, context) → ResolvedAction[]
  ↓
ContextActions component → renders available actions inline
```

Actions route to either direct API calls (deploy, git push, backup) or chat commands (db-push, drop table, truncate, restore) for interactive review workflows.

## Security Model

### Gate System

Two modes:
- **Reactive**: Agent requests gate, user approves (popup)
- **Proactive**: User clicks action button (no gate needed — human is already in the loop)

Gate types: `db_read`, `db_write`, `db_migrate`, `git`, `deploy`, `env`, `logs`, `exec`

### Tier-Based Auth

| Tier | Auth Required |
|------|--------------|
| Standard | Session cookie |
| Web Locked | Session + passkey PoP (FIDO2) |
| Private Locked | Session + passkey + LUKS encryption |

The `tierAuth` middleware enforces this uniformly across all sensitive API routes.

## Per-Sandbox Config

Each sandbox has its own workspace tab configuration stored in `sandbox_workspace_configs`. Users can save configurations as named templates in `workspace_templates` for reuse across sandboxes.

## Key Files

| File | Purpose |
|------|---------|
| `lib/workspace-extensions.ts` | Extension manifests + registry |
| `lib/workspace-presets.ts` | Preset definitions |
| `lib/resolve-workspace-state.ts` | Pure resolver (10-step pipeline) |
| `lib/derive-runtime-mode.ts` | Runtime mode from active tab |
| `lib/workspace-actions.ts` | Dynamic action system |
| `lib/tier-utils.ts` | Product/tier gating |
| `lib/domains.ts` | Configurable domain patterns |
| `lib/migration-workflow.ts` | DB migration chat commands |
| `hooks/useWorkspaceConfig.ts` | Workspace config hook |
| `hooks/useDashboardNav.ts` | URL-based navigation |
| `hooks/useIntegrationState.ts` | Integration state derivation |
| `components/dashboard/TabAddMenu.tsx` | Tab management modal |
| `components/dashboard/ContextActions.tsx` | Dynamic action renderer |
| `components/dashboard/integrations/` | Integration tab components |
