# Agent context templates

Per-locale prose files shipped at scaffold time into every freshly
created project. Each file primes a coding assistant with the user's
language preference + workspace conventions before its first message.

## Files emitted into the user's project

| Source                     | Project path                  | Consumer            |
|----------------------------|-------------------------------|---------------------|
| `claude/<locale>.md`       | `CLAUDE.md`                   | Anthropic Claude Code |
| `agents/<locale>.md`       | `AGENTS.md`                   | Codex CLI, OpenCode, others (universal convention) |
| `cursor-rules/<locale>.md` | `.cursor/rules/main.mdc`      | Cursor v0.50+ |

`GEMINI.md` is intentionally absent (Phase 6a — no Gemini integration).

## Content rules

Every file opens with a sentinel comment:

```markdown
<!-- ellul:locale=<code> -->
```

The Layer 6 mismatch detector (vps-ui's `LocaleMismatchBanner`) reads
this sentinel to confirm the file's authored locale without parsing
prose. The validator (`scripts/validate-key-trees.mjs`) refuses to ship
a locale whose .md files don't carry the matching sentinel.

The prose translates; **code identifiers stay literal English**:

- ✅ Translate: rules, conventions, when-to-use guidance, prose around code
- ❌ Don't translate: `scaffold_project`, `package.json`, `Tailwind`,
  framework names, env vars, CLI flags, file paths

This mirrors the broader Phase 7a-NATIVE boundary documented in
`docs/seo/JA-7a-NATIVE-SMOKE-TESTS.md`.

## Adding a new locale

1. `cp agents/en.md agents/<locale>.md` and translate (same for
   `claude/` and `cursor-rules/`).
2. Update the opening sentinel: `<!-- ellul:locale=<code> -->`.
3. Add the variant to `VARIANTS` in `index.ts`.
4. Add the locale to `SHIPPED_LOCALES` in `src/loaders.ts`.
5. Run `pnpm validate` — the script checks all three files exist with
   the sentinel.
6. Run the JP-NATIVE-QA-TEMPLATE check for the new locale (required
   for ja and ko per the playbook; de/pt-BR/fr can ship without).

## Why this lives in `i18n-messages` and not `vps`

Every translatable surface — UI strings, MOTD text, the unauthorized
landing page, agent context prose — lives in this package. One source
of truth for translators, one validator gate, one place to look when
adding a locale. Consumers (vps' scaffolder, web's Next.js app)
import from here.
