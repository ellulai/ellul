# CLI Maintenance Notes

## Typeahead Menu: readline Private API

The typeahead menu (`repl.ts`, `TypeaheadMenu.activate()`) uses `(rl as any).line` and `(rl as any).cursor` to clear readline's internal buffer when transitioning to raw mode. These are private Node.js APIs.

**Why**: Node's `readline` has no public API to clear the input buffer. When the user types `/`, readline processes and echoes it before our keypress handler fires. We must clear it to prevent the selected command from becoming `//scopes`.

**Risk**: If a future Node.js version renames these properties, the `try/catch` wrapper prevents crashes. Worst case: a stale `/` character appears on screen (cosmetic only — the command still executes correctly).

**Action on Node upgrade**: After upgrading Node.js major versions (e.g., 20 → 22 → 24), test the typeahead menu. If stray characters appear, check if `readline.Interface` internals changed and update the property names.
