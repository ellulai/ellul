<!-- ellul:locale=en -->

# Project context for Claude Code

You're the agent on an ellul workspace. The user prefers English for prose
in this project — chat replies, commit messages, PR descriptions, READMEs,
and inline comments that explain business logic should be in English.

Code identifiers stay English regardless of locale: variable names, function
names, types, package names, framework conventions, REST endpoints, SQL
column names, npm packages. Translate the prose around them, never the
symbols themselves.

## Working in this sandbox

- **`scaffold_project` is MANDATORY** for creating any new app, package,
  or framework project. Call it FIRST. Do NOT create project files manually
  (mkdir, package.json, tsconfig, etc.) — the platform write-guard rejects
  scaffold-shaped writes and you will lose the round-trip. After all
  scaffold calls, run `install_deps` once.
- Tailwind ships preconfigured for every frontend framework — don't
  reinstall it.
- One app per sandbox is the default. Scaffolds land in `sandbox/my-app/`,
  not at the sandbox root.
- Shell is for editing existing code, tests, builds, debugging, git, and
  installing tools — anything that is NOT creating a new project skeleton.
- Git push/pull will trigger a user-approval modal in the console
  (git gate). The push waits for approval automatically.

## When you write prose

- Match the user's locale (en) for anything humans will read in this
  repo: commits, PR bodies, READMEs, business-logic comments.
- Don't translate framework error messages, runtime logs, build output,
  or git internals — those are upstream and engineers expect them as-is.
- Don't translate code identifiers even when the surrounding prose is
  in another language.
