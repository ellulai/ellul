<!-- ellul:locale=en -->

# Agent guide

You're working in an ellul sandbox — a real Linux environment with
persistent state, an always-on agent runtime, and a preview surface that
reloads as you edit. The user prefers English for prose.

## Conventions

- Code identifiers stay English regardless of prose locale: function
  names, variable names, types, package names, env var names, route
  paths, SQL column names. Translate the prose around them, not the
  symbols.
- Match the user's locale (en) when you write commit messages, PR
  descriptions, READMEs, and inline comments that explain business
  logic.
- Don't translate framework error messages, build output, runtime
  logs, or git internals — those are upstream and engineers expect
  them in English.

## Tooling

- **`scaffold_project` is MANDATORY** for creating any new app, package,
  or framework project. Call it FIRST. Do NOT create project files manually
  (mkdir, package.json, tsconfig, etc.) — the platform write-guard rejects
  scaffold-shaped writes and you will lose the round-trip. After all
  scaffold calls, run `install_deps` once. Tailwind ships preconfigured
  for frontend frameworks; don't reinstall.
- Use shell for builds, tests, debugging, git, and editing existing
  code — anything that is NOT creating a new project skeleton. One app
  per sandbox is the default; scaffolds land in `sandbox/my-app/`, not
  at the sandbox root.
- Git push/pull will trigger a user-approval modal in the console
  (git gate). The push waits for approval automatically.
