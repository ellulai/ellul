# App Management System

This document covers how ellul.ai detects, categorizes, and manages apps in a polyglot VPS environment.

## 1. The Detection Hierarchy

ellul.ai determines an app's type using this priority order:

| Priority | Method | Source | Accuracy |
|:---:|---|---|---|
| **1** | **Explicit Config** | `.ellul.json` (Workspace Root) | 100% |
| **2** | **Project Metadata** | `ellul` field in `package.json` | 100% |
| **3** | **Local Metadata** | `ellul.json` (App Folder) | 100% |
| **4** | **Framework Match** | `package.json`, `requirements.txt`, etc. | High |
| **5** | **Language Heuristic** | File extensions (`.go`, `.rs`, `.php`) | Medium |

---

## 2. Explicit Metadata (The "Golden Path")

To guarantee correct detection for **any** language, users (or AI agents) can place a `ellul.json` file in the app root.

### Example: A Rust Web Server

**File:** `~/projects/my-rust-app/ellul.json`
```json
{
  "type": "backend",
  "previewable": true,
  "name": "Rust API",
  "port": 8080
}
```

### Example: A Python Streamlit App

**File:** `~/projects/data-viz/ellul.json`
```json
{
  "type": "frontend",
  "previewable": true,
  "framework": "Streamlit"
}
```

### Rule for AI Agents

> "When creating a project in a language other than Node.js, ALWAYS create a `ellul.json` file to define its type and previewability."

---

## 3. Polyglot Inference (The Backup)

If no metadata exists, we infer the type based on file signatures.

### Frontend Detection (Previewable: True)

Apps that likely serve HTML/UI.

| Language | Signature Files | Keywords to Look For |
|----------|-----------------|----------------------|
| Node.js | `package.json` | `next`, `vite`, `nuxt`, `react`, `vue`, `svelte` |
| HTML | `index.html` | (Presence of file in root/public) |
| Python | `requirements.txt` | `streamlit`, `gradio`, `nicegui`, `django` (with templates) |
| PHP | `index.php`, `composer.json` | `laravel`, `symfony`, `wordpress` |
| Ruby | `Gemfile` | `rails`, `sinatra` (if views detected) |
| Go | `go.mod` | `hugo`, `templ` |

### Backend Detection (Previewable: False)

Apps that likely serve raw JSON/GRPC/TCP.

| Language | Signature Files | Keywords to Look For |
|----------|-----------------|----------------------|
| Node.js | `package.json` | `express`, `nest`, `fastify`, `koa`, `hono` |
| Python | `requirements.txt` | `fastapi`, `flask`, `django` (API mode) |
| Go | `go.mod` | `gin`, `echo`, `fiber` |
| Rust | `Cargo.toml` | `actix`, `axum`, `rocket` |
| Java | `pom.xml`, `build.gradle` | `spring-boot`, `micronaut` |
| C# | `*.csproj` | `AspNetCore` |

### Library/Tool Detection (Hidden)

Code that is not a runnable app.

| Criteria | Result |
|----------|--------|
| No `start`/`dev` scripts (Node) | Library |
| No `main.go` (Go) | Library |
| No `main.rs` or `[bin]` (Rust) | Library |
| Folder name in `.gitignore` | Ignored |

---

## 4. Reactive State Management

The App List must always reflect reality. If a user runs `git clone` or `rm -rf`, the dashboard must update.

### The "Live Scan" Architecture

1. **Polling:** The frontend polls `GET /api/apps` every 3-5 seconds
2. **On-Demand Scan:** The API performs a fresh scan of `~/projects` on every request (fast for <100 folders)
3. **Cache Invalidation:**
   - **User Action:** When user clicks "Ship", "Save", or "New Project", trigger immediate re-fetch
   - **Terminal Action:** 3s polling acts as catch-all for `git clone` etc.

### State Syncing Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  User Terminal  │────▶│ Filesystem Change │     │   Dashboard UI  │
│  (git clone)    │     └──────────────────┘     │  (polls 3s)     │
└─────────────────┘              │                └────────┬────────┘
                                 │                         │
                                 ▼                         ▼
                    ┌──────────────────────────────────────────────┐
                    │           API: GET /api/apps                  │
                    │           (Scans ~/projects)                  │
                    └──────────────────────────────────────────────┘
                                         │
                           ┌─────────────┴─────────────┐
                           ▼                           ▼
                    ┌─────────────┐             ┌─────────────┐
                    │  Metadata?  │             │  Inference  │
                    │  (*.json)   │             │  (Heuristic)│
                    └──────┬──────┘             └──────┬──────┘
                           │                           │
                           └─────────────┬─────────────┘
                                         ▼
                              ┌─────────────────┐
                              │  JSON Response  │
                              │  → Update UI    │
                              └─────────────────┘
```

### Handling "Ghost Apps"

**If folder exists but not running:**
- Status: "Stopped" (inferred from PM2/process list)
- Action: UI shows "Start" button (if start script detected)

**If app is running (port active) but folder is gone:**
- Status: "Orphaned Process"
- Action: UI shows "Stop" to free the port

---

## 5. Configuration Overrides (Workspace Level)

Users can force specific folders to behave differently using the root `.ellul.json`.

```json
{
  "overrides": {
    "legacy-php-site": {
      "type": "frontend",
      "framework": "PHP",
      "previewable": true
    },
    "internal-tool": {
      "hidden": true
    }
  }
}
```

This ensures that no matter what the inference engine guesses, the user has the final say.

---

## 6. Visual Assets (Auto-Resolution)

ellul.ai uses a **passive lookup strategy** to find app icons. It does not move or modify your files.

### Icon Lookup Order

When the dashboard requests an icon for an app, the API checks these paths in order. The first match wins.

| Priority | Location | Best For |
|:---:|---|---|
| **1** | `.ellul/icon.png` | **Explicit Override** (Dashboard only) |
| **2** | `public/favicon.ico` | Next.js / React / Vue |
| **3** | `public/logo.png` | Standard Web Apps |
| **4** | `static/favicon.ico` | Python (Flask/Django) / Go |
| **5** | `assets/logo.png` | Rust / General |
| **6** | `logo.png` (Root) | Simple scripts |

### How to set an icon

* **The "Standard" Way:** Just build your app normally. If you have a favicon or logo in your public folder, we will display it automatically.
* **The "Override" Way:** If you want a specific high-res icon just for the dashboard, place it at `.ellul/icon.png`.

---

## 7. App Types

| Type | Description | Previewable |
|------|-------------|-------------|
| `frontend` | Web UI apps (Next.js, Vite, Streamlit, etc.) | Yes |
| `backend` | API servers (Express, FastAPI, Gin, etc.) | No |
| `library` | Shared packages, no dev server | No |
| `monorepo` | Contains multiple apps (workspaces) | No (children may be) |

---

## 8. API Endpoints

### GET /api/apps

Returns detected apps merged with config.

**Response:**
```json
{
  "apps": [
    {
      "name": "web",
      "path": "/home/dev/projects/web",
      "framework": "next",
      "scripts": ["dev", "build", "start"],
      "type": "frontend",
      "previewable": true
    },
    {
      "name": "rust-api",
      "path": "/home/dev/projects/rust-api",
      "framework": "axum",
      "type": "backend",
      "previewable": false
    }
  ],
  "hasConfig": true
}
```

### GET /api/apps/config

Returns the raw config file contents.

### POST /api/apps/config

Update the config file. Actions:

| Action | Payload |
|--------|---------|
| `hide` | `{ "action": "hide", "app": "folder-name" }` |
| `unhide` | `{ "action": "unhide", "app": "folder-name" }` |
| `override` | `{ "action": "override", "app": "name", "properties": {...} }` |
| `removeOverride` | `{ "action": "removeOverride", "app": "name" }` |
| `addApp` | `{ "action": "addApp", "app": { "name": "...", "type": "..." } }` |
| `removeApp` | `{ "action": "removeApp", "app": "name" }` |

### GET /api/assets/:app/icon

Auto-resolves app icon using passive lookup. Returns the first matching icon file or 404.

**Lookup Order:**
1. `.ellul/icon.png`
2. `public/favicon.ico`
3. `public/logo.png`
4. `public/icon.png`
5. `static/favicon.ico`
6. `static/logo.png`
7. `assets/logo.png`
8. `logo.png`

**Response:** Binary image file with appropriate Content-Type, or 404 if no icon found.

---

## 9. Local Metadata Schema

**File:** `~/projects/{app}/ellul.json`

```json
{
  "name": "My App",
  "type": "frontend",
  "framework": "Custom",
  "previewable": true,
  "port": 3000,
  "startCommand": "npm run dev",
  "buildCommand": "npm run build"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name (optional, defaults to folder) |
| `type` | string | `"frontend"`, `"backend"`, or `"library"` |
| `framework` | string | Display label for the framework |
| `previewable` | boolean | Whether app appears in Preview dropdown |
| `port` | number | Default port for the app |
| `startCommand` | string | Command to start the app |
| `buildCommand` | string | Command to build the app |

---

## 10. UI Controls

### App Selector Dropdown

Located in the header, shows all detected apps grouped by type.

**Features:**
- "All Projects" option to show all files
- Apps grouped by type (Frontends, Backends, Libraries)
- Type icons: Monitor (frontend), Server (backend), Library (library)
- Framework label shown for each app

### App Context Menu

Hover over any app to reveal the menu button.

**Options:**
- **Hide app** - Removes from list, adds to `hidden` in config
- **Change type** - Switch between Frontend/Backend/Library
- **Show in Code** - Jump to app in code browser

### Hidden Apps Section

Expandable section at bottom of dropdown showing hidden apps with "Show" button.

---

## 11. Common Scenarios

### Creating a non-Node.js app

```bash
mkdir ~/projects/my-go-api
cd ~/projects/my-go-api
go mod init my-go-api

# Create ellul.json for proper detection
cat > ellul.json << 'EOF'
{
  "type": "backend",
  "framework": "Go/Fiber",
  "previewable": false
}
EOF
```

### Monorepo with frontend + backend

```
workspace/
├── apps/
│   ├── web/          → frontend (previewable)
│   └── api/          → backend
├── packages/
│   └── shared/       → library
└── .ellul.json
```

Auto-detection will categorize them correctly. Preview dropdown shows only `web`.

### Force a folder to be previewable

Edit `.ellul.json` at workspace root:
```json
{
  "overrides": {
    "my-static-site": {
      "type": "frontend",
      "previewable": true
    }
  }
}
```

---

## 12. Troubleshooting

### App not appearing

1. Check if it's in the hidden list
2. Verify folder has a recognizable project file
3. Create a `ellul.json` in the app folder
4. Manually add via workspace `.ellul.json`

### Wrong app type detected

1. Use context menu to change type, OR
2. Create `ellul.json` in app folder, OR
3. Add override in workspace `.ellul.json`

### Preview not working

1. Check if app is marked `previewable: true`
2. Ensure it's running on port 3000
3. Change type to "frontend" via context menu

### Non-standard language not detected

Create `ellul.json` in the app folder:
```json
{
  "type": "frontend",
  "framework": "Elixir/Phoenix",
  "previewable": true,
  "port": 4000
}
```

### App icon not showing

The dashboard auto-resolves icons from standard locations. If your icon isn't appearing:

1. **Check standard locations:** `public/favicon.ico`, `public/logo.png`, `static/favicon.ico`
2. **Use the override:** Place a square PNG at `.ellul/icon.png` in your app folder
3. **File format:** Use PNG or ICO format, square dimensions recommended

---

## 13. Integration with Context System

When an app is selected in the dashboard, the [Context System](./CONTEXT-SYSTEM.md) loads:

1. Global context (`~/.ellul/context/global.md`)
2. App's `CLAUDE.md` (if exists)
3. App's `README.md` (first 2000 chars)
4. App's `package.json` info (scripts, description)

This ensures AI assistants understand the project when you're working on it.

---

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture overview
- [CONTEXT-SYSTEM.md](./CONTEXT-SYSTEM.md) - AI context injection
- [WORKBENCH.md](./WORKBENCH.md) - Chat interface for AI assistants
