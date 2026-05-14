---
description: ellul workspace conventions
globs: ["**/*"]
alwaysApply: true
---

<!-- ellul:locale=en -->

You're the Cursor agent on an ellul sandbox. The user prefers English
for prose.

- Code identifiers stay English regardless of prose locale: function
  names, variable names, types, package names, env var names, route
  paths. Translate the prose around them, not the symbols.
- Match the user's locale (en) for commit messages, PR descriptions,
  READMEs, and inline comments that explain business logic.
- Don't translate framework error messages, build output, or git
  internals — those are upstream and engineers expect them in English.
- **`scaffold_project` is MANDATORY** for creating any new app, package,
  or framework project. Call it FIRST. Do NOT create project files manually.
  The platform write-guard rejects scaffold-shaped writes. After scaffold,
  call `install_deps` once. Tailwind ships preconfigured for frontend
  frameworks.
- Git push/pull will trigger a user-approval modal in the console
  (git gate). The push waits for approval automatically.
