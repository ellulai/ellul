# Scaffold Template System

Single source of truth for the theming contract every scaffolded frontend app follows.

## The problem this solves

Upstream CLIs (`create-next-app`, `npm create vite`, …) ship templates with
two competing styling systems:

- `globals.css` defines `--background` / `--foreground` CSS variables and
  exposes them via a Tailwind v4 `@theme inline` block
  (`bg-background`, `text-foreground`).
- The default page component hardcodes fixed-color utilities like
  `bg-zinc-50 dark:bg-black` on the root element.

Editing the variable has no visible effect — the component paints over it.
Agents or users who edit one file are confused when the UI doesn't change.
This is a **coherence bug** in the upstream template, not a platform bug,
but it hits every sandbox we create.

## The fix

1. **Design tokens in one place** — `design-tokens.ts` is the canonical
   palette + font stack. Every template derives from it.
2. **Generators** — pure functions in `generators.ts` that emit `globals.css`,
   `page.tsx`, etc. from the token set.
3. **Per-framework override registry** — `overrides.ts` maps framework IDs
   to the file paths whose upstream defaults need replacement, with the
   generator output as the replacement content.
4. **Enforced coherence** — `__tests__/coherence.test.ts` asserts:
   - Every color token has a value.
   - CSS declares every token in `:root`.
   - No scaffold ships a `@media (prefers-color-scheme: dark)` override —
     it would silently shadow user edits to `:root` when the browser is in
     dark mode, breaking "edit `--background`, see the page change."
   - Components emit no hardcoded color utilities that bypass the tokens
     (no `bg-zinc-50`, no `dark:bg-black`, no `bg-[#008000]`).
   - Paths are relative and non-traversing.

## Flow

```
scaffold_project (platform-tools.ts)
  └── 1. run `fw.scaffold.cmd args` inside scratch work dir
  └── 2. flatten nested dirs, sanity-check package.json
  └── 3. delete stray CLAUDE.md / AGENTS.md
  └── 4. getScaffoldOverrides(fw.id) → Record<relPath, contents>
  │      write every override file into scratch work dir
  └── 5. write ellul.json + preview.json
  └── 6. git init + initial commit (coherent files are in rev 1)
  └── 7. atomic rename to final target
```

## Adding a new framework

1. Identify the file paths in the upstream template that break coherence
   (usually `app/page.tsx` + `app/globals.css` or equivalents).
2. Add / reuse a generator in `generators.ts`.
3. Register the override in `OVERRIDES` inside `overrides.ts`.
4. The coherence tests run over all entries automatically — no test file
   edits needed.

## Changing a token

Edit `DESIGN_TOKENS` in `design-tokens.ts`. Every framework's scaffolded
`globals.css` regenerates on next scaffold. Existing sandboxes are
unaffected (they carry their scaffold-time snapshot).

## Non-goals

- **Themeing existing sandboxes.** This is a scaffold-time system only.
  Users who want to re-theme an existing sandbox edit their own
  `globals.css` — the tokens are the contract they're editing against.
- **Tailwind config generation.** Tailwind v4 gets its theme from the
  `@theme inline` block in `globals.css`; no separate config file needed.
- **Dark mode by default.** Scaffolds ship a single color scheme. Apps
  that want dark mode opt in with their own `@media (prefers-color-scheme: dark)`
  block or runtime toggle on top of the tokens — shipping one in the
  scaffold would shadow user edits to `:root`.
