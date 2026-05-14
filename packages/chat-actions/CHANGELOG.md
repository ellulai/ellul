# Changelog

All notable changes to `@ellul.ai/chat-actions` will be documented in this file.

## [1.0.0] — 2026-04-18

### Added

- `ACTIONS` registry — authoritative list of chat Actions dropdown entries (deploy, git-push, db-push, db-drop-table, db-truncate-table, db-backup, db-restore, db-run-migration, db-provision, credentials-sync).
- `resolveActions(state, context)` / `getAvailableActions(state, context)` — pure availability resolver consumed by both `apps/console` and `packages/vps-ui`.
- Shared parity tests that lock the same availability rules across every consumer — drift becomes a test failure, not a rendering bug.
