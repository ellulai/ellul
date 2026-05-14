# ellul UI Guide

## Application Architecture

ellul has two frontend apps and one docs site:

| App | URL | Purpose |
|-----|-----|---------|
| **`apps/web`** | `ellul.ai` | Marketing site, auth (OAuth), pricing |
| **`apps/console`** | `console.ellul.ai` | Authenticated dashboard (server management, coding, AI) |
| **`apps/docs`** | `docs.ellul.ai` | Documentation site |

All three share the same **Ascente** design system (see [Design System](#design-system--the-ascente-theme) below).

---

## Navigation & Route Map

### Web App (`apps/web`)

```
/                     Landing page (hero + pricing + features + FAQ)
/(auth)/sign-up       OAuth signup (GitHub / Google)
/(auth)/sign-in       OAuth signin (GitHub / Google)
/pricing              Redirect → /#pricing
/terms                Terms of service
/privacy              Privacy policy
```

### Console App (`apps/console`)

```
/                             Auth check → redirect to /dashboard or WEB_URL
/dashboard                    Layout: auth, server status polling, state machine
  /dashboard                  Page: overview (apps grid) or plan selection
  /dashboard/app/[appName]    Page: app-specific workspace (chat, code, preview)
/terms                        Terms of service
/privacy                      Privacy policy
```

---

## Complete User Flows

### 1. New User Signup

```
Landing Page (apps/web /)
  │
  ├─ Click "Get Started"
  │
  ▼
OAuth Sign-Up (apps/web /(auth)/sign-up)
  │  ┌─────────────────────────────────┐
  │  │  [GitHub Logo] Sign up with GitHub  │
  │  │  [Google Logo] Sign up with Google  │
  │  └─────────────────────────────────┘
  │
  ├─ OAuth callback → session created
  │
  ▼
Dashboard (apps/console /dashboard)
  │
  ├─ Layout checks session → polls GET /api/servers/status
  ├─ Status = "none" → shows Plan Selection UI
  │
  ▼
Plan Selection (inside DashboardLayout)
  ┌────────────────────────────────────────────┐
  │  Choose Your Plan                           │
  │                                             │
  │  ┌──────┐  ┌──────────┐  ┌───────────┐    │
  │  │ Free │  │ Starter  │  │   Pro     │    │
  │  │  $0  │  │ $15/mo   │  │  $30/mo   │    │
  │  │      │  │          │  │           │    │
  │  │[Start]│  │[Checkout]│  │[Checkout] │    │
  │  └──────┘  └──────────┘  └───────────┘    │
  └────────────────────────────────────────────┘
  │
  ├─ Free: POST /api/servers → auto-provision
  ├─ Paid: Stripe Checkout → /dashboard?checkout=success&tier=starter
  │        → awaitingPaymentConfirmation → auto-provision when subscription confirmed
  │
  ▼
Provisioning State (~60s from warm pool, ~3-4 min cold)
  ┌────────────────────────────────────────────┐
  │  [Spinner]  Setting up your server...       │
  │                                             │
  │  ✓ Starting                                 │
  │  ✓ Writing files                            │
  │  ● Installing packages...                   │
  │  ○ Configuring                              │
  │  ○ Ready                                    │
  │                                             │
  │  Polls every 3s until step = "ready"        │
  └────────────────────────────────────────────┘
  │
  ▼
Active Dashboard
```

### 2. Returning User (Active Server)

```
Visit /dashboard
  │
  ├─ Auth check → session exists
  ├─ Poll server status → "active"
  │
  ▼
Dashboard renders MobileDashboardLayout
  ├─ Overview page (apps grid) at /dashboard
  └─ App workspace at /dashboard/app/[appName]
```

### 3. Returning User (Hibernated Free Tier)

```
Visit /dashboard
  │
  ├─ Poll server status → "hibernated"
  ├─ Auto-trigger POST /api/servers/wake
  │
  ▼
Wake Loading Screen
  ┌────────────────────────────────────────────┐
  │  [Moon Icon]  Waking up your server...      │
  │                                             │
  │  ● Spinning up server...                    │
  │  ○ Restoring your files...                  │
  │  ○ Starting services...                     │
  │  ○ Almost ready...                          │
  │                                             │
  │  Pool hit: ~5-10s | Cold: ~30-60s           │
  │  Polls every 3s until status = "active"     │
  └────────────────────────────────────────────┘
  │
  ▼
Active Dashboard (workspace intact from snapshot)
```

### 4. Subscription Cancellation Flow

```
Active Dashboard
  │
  ├─ Click "Manage Subscription" → Stripe Portal
  ├─ Cancel in Stripe
  │
  ▼
subscription.updated webhook (cancel_at_period_end = true)
  │
  ▼
Dashboard shows amber banner:
  ┌─────────────────────────────────────────────────────────┐
  │ ⚠ Subscription ending on [date]. Full access until then. │
  │                                     [Undo Cancel]        │
  └─────────────────────────────────────────────────────────┘
  │
  ├─ Server stays ACTIVE until period ends
  │
  ▼  (period ends)
subscription.deleted webhook
  │
  ▼
Pending Deletion State (24hr grace)
  ┌────────────────────────────────────────────┐
  │  Your server will be deleted in 23:45:12    │
  │                                             │
  │  [Resubscribe Now]                          │
  └────────────────────────────────────────────┘
  │
  ├─ Resubscribe: new Stripe checkout → restore server
  └─ 24hr expires: server permanently deleted → status = "none"
```

### 5. Free Tier Session Lifecycle

```
Server Active
  │
  ├─ useBrowserHeartbeat sends HMAC heartbeat every 30s
  ├─ Tracks mouse/keyboard/touch activity + tab visibility
  │
  ├─ AT 50 MINUTES: warningActive = true (session info available)
  │
  ├─ AT 60 MINUTES: softCapNotifiedAt set by free-tier-manager
  │
  ▼
SessionExtendModal appears:
  ┌────────────────────────────────────────────┐
  │  Still working?                             │
  │                                             │
  │  Your session will hibernate in 9:42        │
  │                                             │
  │  [Keep Working]  [Upgrade]  [Let it sleep]  │
  └────────────────────────────────────────────┘
  │
  ├─ "Keep Working": HMAC renew → resets session timer + softCapNotifiedAt
  ├─ "Upgrade": opens plan selector
  ├─ "Let it sleep": closes modal → hibernates after grace
  ├─ No response in 10min: auto-hibernate
  │
  ▼ (if hibernated)
User returns → auto-wake flow (see flow #3)
```

---

## Dashboard State Machine

The `DashboardLayout` (`apps/console/src/app/dashboard/layout.tsx`) is the central orchestrator. It polls `GET /api/servers/status` and renders different UI based on server state.

```
                    ┌──────────┐
                    │   none   │ ── Plan Selection UI
                    └────┬─────┘
                         │ create / checkout
                         ▼
                  ┌──────────────┐
                  │ provisioning │ ── Progress spinner (polls 3s)
                  └──────┬───────┘
                         │ step = "ready"
                         ▼
  ┌─────────────┐  ┌──────────┐  ┌──────────────────┐
  │ hibernated  │◄─│  active   │─►│ pending_deletion │
  │ (free tier) │  └──────────┘  └──────────────────┘
  └──────┬──────┘       │
         │ auto-wake    │ provision error
         ▼              ▼
   (back to active) ┌────────┐
                    │ error  │ ── Delete & Retry button
                    └────────┘
```

### What Each State Renders

| State | UI | Key Actions |
|-------|----|-|
| `none` | Plan selector (Free / Starter / Pro cards), `TierSelector` component | Create free server, Stripe checkout for paid |
| `provisioning` | Animated spinner with step indicators | Auto-polls every 3s |
| `active` | Full dashboard (`MobileDashboardLayout` via child pages) | All features available |
| `hibernated` | Wake loading screen with progress steps | Auto-triggers `POST /api/servers/wake` |
| `error` | Error message panel | "Delete & Try Again" button |
| `pending_deletion` | Countdown timer with resubscribe option | "Resubscribe Now" → Stripe checkout |

---

## Active Dashboard Layout

When the server is active, the layout provides context providers and renders child pages.

### Provider Hierarchy

```
DashboardLayout (auth + server status polling)
  └─ DashboardContext.Provider (server data + actions)
      └─ VpsBridgeProvider (passkey auth iframe)
          └─ CodeTokenProvider (file-api auth tokens)
              └─ VpsCapabilitiesProvider (feature detection)
                  └─ AppsListProvider (apps list + CRUD)
                      └─ {children}  ← page.tsx or app/[appName]/page.tsx
```

### Page Structure

**`/dashboard` (Overview Page)**
Renders `MobileDashboardLayout` with `view="overview"`:
- Apps grid showing all detected projects
- Search + filter by type (frontend/backend/library)
- "Create App" / "Import from Git" buttons
- App cards with framework badge, type icon, deploy status

**`/dashboard/app/[appName]` (App Workspace)**
Renders `MobileDashboardLayout` with `view="app"`:
- WorkbenchProvider wraps at page level (fresh state per app)
- Three contexts: Workspace, Deployed, Settings
- Each context has its own tab set

---

## MobileDashboardLayout

**File:** `apps/console/src/components/dashboard/MobileDashboardLayout.tsx`

The main dashboard shell. Handles navigation, real-time updates, and tab rendering.

### Navigation Model (App-Centric)

```
┌─────────────────────────────────────────────────────────┐
│  HEADER                                                  │
│  [← Back] App Name (framework)  │  [Settings] [More ▼] │
├─────────────────────────────────────────────────────────┤
│  CONTEXT SWITCHER (only in app view)                     │
│  [Workspace]  [Deployed]  [App Settings]                 │
├─────────────────────────────────────────────────────────┤
│  TAB BAR (changes per context)                           │
│  Workspace: [Chat] [Code] [Preview]                      │
│  Deployed:  [Code] [Details]                             │
│  Settings:  [Context] [Git] [Danger]                     │
├─────────────────────────────────────────────────────────┤
│                                                          │
│                    TAB CONTENT                            │
│                                                          │
└─────────────────────────────────────────────────────────┘
│  MOBILE BOTTOM NAV (visible < md)                        │
│  [Overview] [Chat] [Code] [Preview] [Settings]           │
└─────────────────────────────────────────────────────────┘
```

### Views

| View | Route | What Shows |
|------|-------|------------|
| `overview` | `/dashboard` | `OverviewPage` — apps grid, server stats header |
| `app` | `/dashboard/app/[name]` | App-specific workspace with context switcher |

### Contexts & Tabs (App View)

| Context | Tabs | Description |
|---------|------|-------------|
| **Workspace** | Chat, Code, Preview | Active development — terminal/AI, file browser, live preview |
| **Deployed** | Code, Details | Production view — deployed source, domain info, logs |
| **Settings** | Context, Git, Danger | Config — AI context files, git repo linking, delete/rebuild |

### Security Tier Restrictions

| Tier | Workspace Tabs | Available Contexts |
|------|---------------|-------------------|
| `standard` | Chat, Code, Preview | All |
| `web_locked` | Chat, Code, Preview (with passkey gates) | All |

---

## Tab Components

### TabEditor (Chat Tab)

**File:** `apps/console/src/components/dashboard/tabs/TabEditor.tsx`

Dual-mode: **Workbench (AI Chat)** and **Terminal** — toggled via header switch.

**Workbench:**
```
┌─────────────────────────────────────────────────────────┐
│  [Thread Picker ☰]  │  Workbench ◉  Terminal ○          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│                   AI CHAT MESSAGES                        │
│                                                          │
│  User: Build me a landing page                           │
│                                                          │
│  Assistant: I'll create a Next.js landing page...        │
│  [thinking steps collapsed]                              │
│                                                          │
├─────────────────────────────────────────────────────────┤
│  [Session: OpenCode ▼]  Type a message... [Send]         │
└─────────────────────────────────────────────────────────┘
```

- Thread picker (sheet/sidebar) for managing conversation threads
- Session selector: OpenCode, Claude, Codex, Gemini
- Thinking steps display (collapsible)
- Messages stored per-thread via WorkbenchContext

**Terminal Mode:**
```
┌─────────────────────────────────────────────────────────┐
│  TOOLS: [Shell][Git][Logs][Clean]                        │
│  AI AGENTS: [OpenCode][Claude][Codex][Gemini]            │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │  ● Shell                             [⬜] [✕]      │  │
│  ├────────────────────────────────────────────────────┤  │
│  │                                                    │  │
│  │                Terminal iframe (ttyd)               │  │
│  │                                                    │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

- Embedded terminal via iframe to ttyd service
- Hold Cmd/Ctrl + click to open in new window
- CSS `hidden`/`block` preserves terminal state across tab switches

### TabCode (Code Tab)

**File:** `apps/console/src/components/dashboard/tabs/TabCode.tsx`

File browser with syntax highlighting and git change tracking.

```
┌─────────────────────────────────────────────────────────┐
│  [Files] [Changes (3)]                       [Refresh]   │
├──────────────────────┬──────────────────────────────────┤
│  FILE TREE           │  FILE VIEWER                      │
│  ├── src/            │  ┌────────────────────────────┐   │
│  │   ├── app/        │  │ src/app/page.tsx      [M]  │   │
│  │   │   └── page.tsx│  ├────────────────────────────┤   │
│  │   └── lib/        │  │ export default function    │   │
│  ├── package.json    │  │   Page() {                 │   │
│  └── tsconfig.json   │  │   return <div>Hello</div>  │   │
│                      │  │ }                          │   │
│  GIT CHANGES         │  └────────────────────────────┘   │
│  M  src/app/page.tsx │                                   │
│  A  src/lib/utils.ts │                                   │
└──────────────────────┴──────────────────────────────────┘
```

- Toggle between file tree and git changes view
- Mobile: full-screen file viewer with back button
- Desktop: split pane (tree left, viewer right)
- Git status badges: M (modified), A (added), D (deleted), ?? (untracked)
- Polls every 3s for file/git changes via file-api

### TabPreview (Preview Tab)

**File:** `apps/console/src/components/dashboard/tabs/TabPreview.tsx`

Live app preview with viewport controls.

```
┌─────────────────────────────────────────────────────────┐
│  [Responsive ▼] [↻ Rotate] [↻ Refresh] [↗ Open]        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐  │
│  │                                                    │  │
│  │              App Preview (iframe)                  │  │
│  │              dev server on port 3000               │  │
│  │                                                    │  │
│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘  │
└─────────────────────────────────────────────────────────┘
```

- Viewport presets: Responsive, Mobile (375px), Tablet (768px), Desktop (1440px)
- Rotation toggle for portrait/landscape
- Shows "switching" or "not ready" states when app isn't running

### TabHome (Home/Overview Tab)

**File:** `apps/console/src/components/dashboard/tabs/TabHome.tsx`

Server overview with stats, connection details, and danger zone.

```
┌─────────────────────────────────────────────────────────┐
│  [CPU 12%] [Memory 42%] [Storage 28%] [Uptime 5d 12h]   │
├──────────────────────────┬──────────────────────────────┤
│  CONNECTION DETAILS      │  ACCESS CONFIG               │
│  IP: 192.168.1.100 [📋] │  Web Terminal ✓              │
│  URL: https://... [↗]   │  SSH Access ✓                │
│  SSH: ssh dev@... [📋]  │  HTTPS Preview ✓             │
├──────────────────────────┴──────────────────────────────┤
│  ENVIRONMENT VARIABLES                                   │
│  [SecretsManager — add/edit/delete encrypted env vars]   │
├─────────────────────────────────────────────────────────┤
│  DANGER ZONE                                             │
│  [Rebuild Server]  [Delete Server]                       │
│  [Rollback] (if snapshot)  [Update] (if available)       │
└─────────────────────────────────────────────────────────┘
```

### TabGit (Git Tab)

**File:** `apps/console/src/components/dashboard/tabs/TabGit.tsx`

Git provider integration for pushing code to GitHub/GitLab/Bitbucket.

- Connect git provider (OAuth flow)
- Link/unlink repositories per app
- Push/force-push/pull actions
- Deploy configuration

### ThreadPicker (Workbench Chat Sidebar)

**File:** `apps/console/src/components/dashboard/tabs/ThreadPicker.tsx`

Sheet/sidebar for managing AI conversation threads.

```
┌─────────────────────────────────────────────┐
│  Threads (5)                                 │
│                                              │
│  NEW THREAD BUTTONS                          │
│  [OpenCode] [Claude] [Codex] [Gemini]        │
├──────────────────────────────────────────────┤
│  ┌────────────────────────────────────────┐  │
│  │ [⚡] Build landing page     OpenCode   │  │
│  │      2m ago                    [⋮]     │  │
│  ├────────────────────────────────────────┤  │
│  │ [🧠] Debug auth flow        Claude     │  │
│  │      1h ago                    [⋮]     │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  Thread menu: [Rename] [Delete]              │
└──────────────────────────────────────────────┘
```

- Color-coded by AI session type
- Rename/delete via context menu
- Free tier notice about auto-save on hibernate

---

## Dashboard Components

### OverviewPage

**File:** `apps/console/src/components/dashboard/OverviewPage.tsx`

The default view at `/dashboard` — shows all detected apps/projects.

```
┌─────────────────────────────────────────────────────────┐
│  Your Apps                    [Search...] [+ Create App] │
├─────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ [Monitor]    │  │ [Server]     │  │ [Layers]     │  │
│  │ my-frontend  │  │ api-server   │  │ monorepo     │  │
│  │ Next.js      │  │ Express      │  │ Turborepo    │  │
│  │ Frontend     │  │ Backend      │  │ Monorepo     │  │
│  │              │  │ ● Deployed   │  │              │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
```

- Click app card → navigate to `/dashboard/app/[appName]`
- Create blank app or import from git via `OnboardingFlow`
- Hide/unhide/delete apps via context menu
- Type icons: Monitor (frontend), Server (backend), Library, Layers (monorepo)

### TierSelector

**File:** `apps/console/src/components/dashboard/TierSelector.tsx`

Plan selection cards shown when status = "none". Includes preview pricing dialog for upgrades.

### SandboxBanner

**File:** `apps/console/src/components/dashboard/SandboxBanner.tsx`

Amber banner shown at top of dashboard for free tier users:
```
⚠ Dev Sandbox — Free Tier | No deploys · No git push · Auto-saves on idle | [Upgrade]
```

### FreePaidComparison

**File:** `apps/console/src/components/dashboard/FreePaidComparison.tsx`

Feature comparison table (Free vs Paid) with upgrade CTA. Shown in free tier dashboard.

### SessionExtendModal

**File:** `apps/console/src/components/dashboard/SessionExtendModal.tsx`

"Still there?" modal for free tier soft session cap. Countdown timer, HMAC-authenticated "Keep Working" button, upgrade option.

### VpsUpdateBanner

**File:** `apps/console/src/components/dashboard/VpsUpdateBanner.tsx`

Banner when server update is available (new platform version).

### SecurityCard / SecuritySettings / SecurityTierCard

Security configuration UI:
- Security tier display (Standard / Web Locked)
- SSH key management (`SshKeysManager`)
- Passkey registration
- TLS mode configuration (`TLSModeCard`)

### OnboardingFlow

**File:** `apps/console/src/components/dashboard/OnboardingFlow.tsx`

Create new app wizard:
- Blank app (choose framework template)
- Import from Git (GitHub/GitLab/Bitbucket repo selector)

### AuthWall

**File:** `apps/console/src/components/dashboard/AuthWall.tsx`

Gate for security-tier-restricted operations. Shows passkey prompt or SSH instructions.

---

## Contexts & State Management

### DashboardContext

**File:** `apps/console/src/contexts/DashboardContext.tsx`

Central server state and action dispatcher. Provided by `DashboardLayout`.

```typescript
interface DashboardContextValue {
  serverStatus: ServerStatus | undefined;
  isStatusLoading: boolean;
  session: Session | null;
  // Server lifecycle actions
  onDeleteServer: () => void;        isDeleting: boolean;
  onRebuildServer: () => void;       isRebuilding: boolean;
  onRollbackServer?: () => void;     isRollingBack: boolean;
  onUpdateServer?: () => void;       isUpdating: boolean;
  onRetryUpdate?: () => void;
  onForceUpdate?: () => void;
  snapshotExpiresAt?: string | null;
  onUpgrade?: () => void;
}
```

### WorkbenchContext

**File:** `apps/console/src/contexts/WorkbenchContext.tsx`

Per-app AI chat state. Mounted at **page level** so it remounts per app.

```typescript
// Manages:
threads: Thread[]               // All threads for this app
activeThreadId: string | null   // Currently selected thread
messages: ThreadMessage[]       // Messages in active thread
processingState: ...            // AI thinking steps (reconnect-friendly)
isConnected: boolean            // WebSocket status

// Actions:
createThread(session)           // New thread with AI session type
selectThread(id)                // Switch active thread
deleteThread(id) / renameThread(id, title)
addLocalMessage(msg)            // Optimistic UI update
saveMessage(msg)                // Persist to VPS SQLite
```

### AppsListContext

**File:** `apps/console/src/contexts/AppsListContext.tsx`

Detected apps/projects on the server. Mounted at **layout level** (persists across navigation).

```typescript
// Manages:
apps: AppInfo[]     // Detected projects with framework, type, ports
isLoading: boolean
codeApiUrl: string  // File-api base URL

// Actions:
createBlankApp(name, template)
importGitApp(repoUrl, branch)
deleteApp(directory)
hideApp(directory) / unhideApp(directory)
overrideApp(directory, overrides)
```

### CodeTokenContext

**File:** `apps/console/src/contexts/CodeTokenContext.tsx`

Handles authentication for file-api requests. Fetches PoP-validated tokens when server is in `web_locked` security tier.

---

## Hooks

| Hook | File | Purpose |
|------|------|---------|
| `useBrowserHeartbeat` | `hooks/useBrowserHeartbeat.ts` | HMAC challenge-response heartbeat for free tier. Tracks activity (mouse/keyboard/touch), tab visibility. 30s interval. |
| `useRealtimeUpdates` | `hooks/useRealtimeUpdates.ts` | WebSocket subscription to file-api for real-time file tree, git status, apps list, and server metrics. |
| `useWorkbenchWebSocket` | `hooks/useWorkbenchWebSocket.ts` | WebSocket to VPS workbench service. Routes messages to WorkbenchContext. |
| `useCurrentApp` | `hooks/useCurrentApp.ts` | Fetches app metadata + activates preview for `/dashboard/app/[name]`. |
| `useCodeToken` | `hooks/useCodeToken.ts` | Gets auth token for file-api requests. |
| `useVpsCapabilities` | `hooks/useVpsCapabilities.ts` | Queries VPS for supported features (version detection). |
| `useVpsFeature` | `hooks/useVpsFeature.ts` | Checks if a specific VPS feature is available. |
| `useVisibility` | `hooks/useVisibility.ts` | Tracks document visibility (Page Visibility API). |

---

## VPS Auth Dialog (Passkey / SSH Confirmation)

When server operations (delete, rebuild, update, rollback) are attempted on security-locked servers, the API returns a 403 with auth requirements.


**Web Locked Mode:**
```
┌────────────────────────────────────────────┐
│  Confirm with Passkey                       │
│                                             │
│  This operation requires passkey            │
│  confirmation (Face ID / Touch ID).         │
│                                             │
│  [Confirm with Passkey]    [Cancel]         │
│                                             │
│  Uses VPS Bridge iframe for WebAuthn        │
└────────────────────────────────────────────┘
```

Flow: API 403 → `setVpsAuthDialog()` → dialog renders → user confirms → resend with `passkeyConfirmation` token.

---

## Responsive Design

### Breakpoints

| Breakpoint | Width | Layout Changes |
|------------|-------|----------------|
| Mobile | < 640px | Bottom nav, single column, full-screen file viewer |
| `sm` | 640px | Minor adjustments |
| `md` | 768px | Top nav, split panes begin |
| `lg` | 1024px | Full desktop layout, sidebars |
| `xl` | 1280px | Wide layout, extra spacing |

### Mobile Patterns
- Bottom tab bar with safe area padding (iOS)
- Sheet components for sidebars (thread picker)
- Full-screen overlay for file viewing (tap to view, back to close)
- Terminal "select mode" overlay for copy/paste on touch devices
- Hamburger menu for navigation overflow

### Desktop Patterns
- Top navigation with breadcrumbs
- Split panes (file tree + viewer, chat + sidebar)
- Hover-reveal actions on thread items, app cards
- Keyboard shortcuts (Cmd+click to open terminal externally)

---

## Real-Time Data Flow

```
VPS Server (file-api WebSocket, port 3002)
  │
  ├─ File tree changes
  ├─ Git status updates
  ├─ Apps list changes
  ├─ Server metrics (CPU, RAM, active sessions)
  │
  ▼
useRealtimeUpdates hook (WebSocket client)
  │
  ▼
MobileDashboardLayout (state updates)
  │
  ├─ TabCode (file tree refresh)
  ├─ OverviewPage (apps list refresh)
  ├─ TabHome (stats refresh)
  └─ TabPreview (app status)


VPS Server (Workbench WebSocket, port 7700)
  │
  ├─ AI response messages
  ├─ Thinking steps
  ├─ Thread data
  │
  ▼
useWorkbenchWebSocket hook
  │
  ▼
WorkbenchContext → NativeChat (message display)
```

---

## Design System — The Ascente Theme

All three ellul apps — **console**, **web**, and **docs** — share the same unified design language: the **Ascente** theme. Named after the Nike Total 90 Ascente, the official Premier League match ball for the 2009/10 season.

### Design Principles

| Principle | Implementation |
|-----------|----------------|
| **Hi-Vis Yellow Canvas** | Radial gradient background (`#FFD740` → `#FFA000` → `#F57C00`) with dimple texture |
| **Plum Panels** | `bg-[#2E004B]` cards with 2px black seam borders — the ball's purple geometric panels |
| **Orange Accents** | `#FFA000` for primary actions, tier names, badges — the ball's stitching highlights |
| **Black Seams** | `border-2 border-black` on all panels — bold structural outlines |
| **Orbitron Display** | Geometric uppercase headings echoing the ball's angular panel construction |
| **Vista Screensaver Circles** | Floating animated circles drifting continuously across the background |
| **Micro-Dimple Texture** | SVG pattern overlay at 5% opacity mimicking the ball's grippy PU casing |
| **Mobile Responsive** | Icon-only on mobile, labels on desktop |

### Status Colors

| Status | Color | Usage |
|--------|-------|-------|
| Success | `orange-500` / `#FFA000` | Active states, confirmations |
| Warning | `amber-500` | Pending deletion, high usage |
| Error | `red-500` | Failed states, destructive actions |
| Info | `cyan-500` | AI agent indicators |

### CSS Variables (Console)

```css
:root {
  --background: 43 100% 50%;       /* #FFC107 amber yellow — hi-vis base */
  --foreground: 0 0% 0%;            /* Black text on yellow */
  --card: 275 100% 15%;             /* #2E004B deep plum — panel bg */
  --card-foreground: 210 40% 98%;   /* White text on purple */
  --primary: 38 100% 50%;           /* #FFA000 orange — seam accent */
  --primary-foreground: 0 0% 0%;
  --secondary: 275 100% 20%;        /* #3D0066 lighter plum */
  --border: 0 0% 0%;                /* Black seams */
  --ring: 38 100% 50%;              /* Orange focus ring */
}
```

### Tailwind Ascente Tokens

```typescript
colors: {
  ascente: {
    yellow:        "#FFC107",   // Hi-vis yellow base
    "yellow-light": "#FFD740",  // Gradient bright centre
    orange:        "#FFA000",   // Primary accent (seam stitching)
    "orange-deep": "#F57C00",   // Panel top-border, gradient edge
    plum:          "#2E004B",   // Deep purple panels
    "plum-light":  "#3D0066",   // Lighter plum (hover states)
    black:         "#000000",   // Seam borders
    seam:          "#000000",   // Alias for black seams
  },
}
```

### Core CSS Classes

```css
/* Standard panel — plum bg, black seam borders, orange top accent */
.panel-ascente {
  @apply bg-[#2E004B] border-2 border-black shadow-panel-lift rounded-2xl;
  border-top: 4px solid #F57C00;
}
```

### Box Shadows

| Token | Value | Usage |
|-------|-------|-------|
| `shadow-panel-lift` | `0 10px 30px rgba(0,0,0,0.5)` | `.panel-ascente`, elevated cards |
| `shadow-neon` | `0 0 20px -5px rgba(249,115,22,0.3)` | Subtle orange glow |
| `shadow-neon-bright` | `0 0 20px rgba(234,88,12,0.4)` | "Most Popular" badge, primary CTA |
| `shadow-dot` | `0 0 8px rgba(249,115,22,1)` | Active dot indicators |

### Typography

| Tailwind Class | Family | Usage |
|----------------|--------|-------|
| `font-display` | Orbitron | Headings, tier names, buttons, section labels |
| `font-sans` | Inter | Body text, descriptions |
| `font-mono` | Geist Mono | Code snippets, technical values |

### Animated Background — Vista Screensaver Circles

Two circles with plum-coloured borders float independently over the yellow gradient canvas. Pure GPU-composited CSS transforms for zero layout impact.

- Large circle: 800px diameter, 80-second loop
- Small circle: 500px diameter, 90-second loop
- Scale down on mobile via `--circle-scale` CSS variable

---

## UI Component Library

### Button Variants

```typescript
const buttonVariants = {
  default: "bg-orange-600 text-white hover:bg-orange-500 shadow-neon-bright",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  outline: "border border-[#3D0066] bg-[#3D0066]/30 text-slate-300 hover:bg-white/[0.06]",
  ghost: "hover:bg-white/[0.06] hover:text-white text-slate-400",
  link: "text-orange-500 underline-offset-4 hover:underline",
};
```

### Styling Patterns

**Card/Panel:**
```tsx
<div className="panel-ascente p-5">{/* Content */}</div>
```

**Section Header:**
```tsx
<div className="flex items-center gap-2 mb-2">
  <div className="h-1.5 w-1.5 rounded-full bg-orange-500" />
  <span className="text-[10px] font-medium text-white/50 uppercase tracking-wider">
    Section Title
  </span>
</div>
```

**Empty State:**
```tsx
<div className="flex-1 flex items-center justify-center border-2 border-dashed border-white/10 rounded-xl">
  <div className="text-center p-8">
    <Icon className="h-8 w-8 text-white/30 mx-auto mb-4" />
    <h3 className="text-sm font-medium text-white/60">Title</h3>
    <p className="text-xs text-white/40">Description</p>
  </div>
</div>
```

### Color Usage

**On plum panels:**

| Color | Usage |
|-------|-------|
| `text-white` | Primary text |
| `text-white/60` | Secondary text |
| `text-white/40` | Muted labels |
| `text-[#FFA000]` | Accents, highlights |
| `text-red-400` | Error/danger |
| `text-amber-400` | Warning |

**On yellow canvas:**

| Color | Usage |
|-------|-------|
| `text-black` | Primary headings |
| `text-black/70` | Body text |
| `text-[#2E004B]` | Branded text |

---

## Landing Page Structure

**File:** `apps/web/src/app/page.tsx`

```
┌─────────────────────────────────────────────────────────┐
│  HERO                                                    │
│  ellul                                              │
│  "Your server, your keys, your rules."                   │
│  [Get Started]  [See Pricing ↓]                          │
├─────────────────────────────────────────────────────────┤
│  PRICING (#pricing)                                      │
│  [Region Selector: US-E | US-W | EU-C | EU-N | APAC]    │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐          │
│  │Wkbnch│ │ Pro  │ │ Plus │ │ Biz  │ │Scale │          │
│  │ $15  │ │ $30  │ │ $45  │ │ $75  │ │$135  │          │
│  │      │ │POPULAR│ │      │ │      │ │      │          │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘          │
│  [EU Region Bonus callout — shown if EU selected]        │
├─────────────────────────────────────────────────────────┤
│  EVERY PLAN INCLUDES                                     │
│  [Sovereign Mode] [Auto HTTPS] [AI Dev] [No Lock-in]    │
├─────────────────────────────────────────────────────────┤
│  FAQ (expandable <details>)                              │
├─────────────────────────────────────────────────────────┤
│  BOTTOM CTA  [Get Started]                               │
└─────────────────────────────────────────────────────────┘
```

### Region Selector

Five deploy regions, auto-detected on page load:

| Region | ID | Location | EU Bonus? |
|--------|----|----------|-----------|
| US East | `us-east` | N. Virginia | No |
| US West | `us-west` | Oregon | No |
| EU Central | `eu-central` | Germany | Yes (2x RAM) |
| EU North | `eu-north` | Finland | Yes (2x RAM) |
| Asia Pacific | `asia-pacific` | Singapore | No |

**Auto-detection:** Geolocation → timezone fallback → default US East.

### Pricing Tiers

| Tier | Display Name | Price | RAM (US) | RAM (EU) | vCPU | Disk | Transfer |
|------|-------------|-------|----------|----------|------|------|----------|
| `starter` | Workbench | $15 | 1 GB | 1 GB | 1 | 25 GB | 1 TB |
| `pro` | Sovereign Pro | $30 | 2 GB | 4 GB | 2 | 40 GB | 2 TB |
| `plus` | Sovereign Plus | $45 | 4 GB | 8 GB | 2 | 80 GB | 3 TB |
| `business` | Sovereign Business | $75 | 8 GB | 16 GB | 4 | 160 GB | 4 TB |
| `scale` | Sovereign Scale | $135 | 16 GB | 32 GB | 8 | 320 GB | 5 TB |

**Mobile:** Horizontal scroll carousel with `snap-x`, `w-[260px]` cards.
**Desktop:** 5-column CSS grid, recommended card has `ring-2 ring-[#FFA000]` and `-translate-y-1.5` lift.

---

## File Reference

```
apps/console/src/
├── app/
│   ├── layout.tsx                        # Root layout (React Query, fonts)
│   ├── page.tsx                          # Auth redirect → /dashboard
│   ├── dashboard/
│   │   ├── layout.tsx                    # Auth, server polling, state machine, providers
│   │   ├── page.tsx                      # Overview page (MobileDashboardLayout view=overview)
│   │   ├── loading.tsx                   # Suspense fallback
│   │   └── app/[appName]/
│   │       ├── page.tsx                  # App workspace (MobileDashboardLayout view=app)
│   │       └── loading.tsx               # Suspense fallback
│   ├── terms/page.tsx                    # Terms of service
│   ├── privacy/page.tsx                  # Privacy policy
│   └── not-found.tsx                     # 404 page
├── contexts/
│   ├── DashboardContext.tsx              # Server status + lifecycle actions
│   ├── WorkbenchContext.tsx               # AI chat threads + messages
│   ├── AppsListContext.tsx               # Detected apps/projects
│   └── CodeTokenContext.tsx              # File-api auth tokens
├── hooks/
│   ├── useBrowserHeartbeat.ts            # Free tier HMAC heartbeat
│   ├── useRealtimeUpdates.ts             # WebSocket file-api subscription
│   ├── useWorkbenchWebSocket.ts           # WebSocket Workbench subscription
│   ├── useCurrentApp.ts                  # App metadata + preview activation
│   ├── useCodeToken.ts                   # File-api auth
│   ├── useVpsCapabilities.ts             # VPS feature detection
│   ├── useVpsFeature.ts                  # Feature flag check
│   └── useVisibility.ts                  # Page Visibility API
├── components/
│   ├── dashboard/
│   │   ├── MobileDashboardLayout.tsx     # Main dashboard shell (nav, tabs, app context)
│   │   ├── OverviewPage.tsx              # Apps grid, search, create/import
│   │   ├── OnboardingFlow.tsx            # Create app wizard
│   │   ├── TierSelector.tsx              # Plan selection cards + pricing preview
│   │   ├── SandboxBanner.tsx             # Free tier warning banner
│   │   ├── FreePaidComparison.tsx        # Free vs Paid feature table
│   │   ├── SessionExtendModal.tsx        # "Still there?" modal (free tier)
│   │   ├── ServerStatus.tsx              # Provisioning progress display
│   │   ├── SecretsManager.tsx            # Encrypted env var management
│   │   ├── SecurityCard.tsx              # Security tier display
│   │   ├── SecuritySettings.tsx          # Security configuration
│   │   ├── SecurityTierCard.tsx          # Tier badge + info
│   │   ├── SshKeysManager.tsx            # SSH key management
│   │   ├── TLSModeCard.tsx              # TLS/HTTPS configuration
│   │   ├── VpsUpdateBanner.tsx           # Platform update available banner
│   │   ├── AppGrid.tsx                   # Apps grid display
│   │   ├── AuthWall.tsx                  # Security-gated operations
│   │   ├── ContextSettings.tsx           # AI context file editor
│   │   ├── CreateStackForm.tsx           # Stack creation form
│   │   ├── ConfigVerificationDialog.tsx  # Config verification
│   │   ├── DeployedCodeView.tsx          # Deployed app source viewer
│   │   ├── DeployedDetails.tsx           # Deployed app details
│   │   ├── TerminalControlDeck.tsx       # Terminal session controls
│   │   └── tabs/
│   │       ├── TabEditor.tsx             # Chat/Terminal dual-mode tab
│   │       ├── TabCode.tsx               # File browser + git changes
│   │       ├── TabPreview.tsx            # Live app preview
│   │       ├── TabHome.tsx               # Server overview + stats
│   │       ├── TabGit.tsx                # Git provider integration
│   │       ├── TabDeployed.tsx           # Deployed apps tab
│   │       ├── NativeChat.tsx            # AI chat message display
│   │       ├── WorkbenchContainer.tsx     # Chat container wrapper
│   │       ├── TerminalSessionSidebar.tsx # Terminal session list
│   │       └── ThreadPicker.tsx          # Thread management sidebar
│   └── ui/                               # shadcn/ui components
│       ├── button.tsx, badge.tsx, dialog.tsx, spinner.tsx, sheet.tsx, ...
├── lib/
│   ├── api.ts                            # API client (hono RPC)
│   ├── auth-client.ts                    # better-auth client
│   ├── vps-bridge.ts                     # VPS Bridge iframe (passkey auth)
│   └── tier-utils.ts                     # Tier comparison helpers
└── providers/
    └── VpsCapabilitiesProvider.tsx        # VPS feature detection provider

apps/web/src/
├── app/
│   ├── layout.tsx                        # Root layout
│   ├── page.tsx                          # Landing page (hero + pricing + FAQ)
│   ├── pricing/page.tsx                  # Redirect → /#pricing
│   ├── (auth)/
│   │   ├── layout.tsx                    # Auth layout (centered card)
│   │   ├── sign-up/page.tsx              # OAuth signup (GitHub + Google)
│   │   └── sign-in/page.tsx              # OAuth signin (GitHub + Google)
│   └── not-found.tsx                     # 404 page
└── components/                           # Landing page sections
```
