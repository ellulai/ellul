// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Chat Action Registry — the single source of truth.
 *
 * Both the chat iframe (`@ellul.ai/vps-ui`) and the console workspace view
 * (`apps/console`) import from here. Any new action is added once and shows
 * up wherever the resolver is consulted.
 *
 * To add a new action:
 *   1. Add the entry here.
 *   2. If it requires a new category / severity / gate type, update
 *      `@ellul.ai/types/integrations.ts` first so every consumer compiles.
 *   3. Add an icon mapping alongside the consumer surface (vps-ui owns
 *      its own icon map; the console does the same).
 */

import type { ChatAction } from "@ellul.ai/types";

export const ACTIONS: readonly ChatAction[] = [
  // ── Workspace context ──────────────────────────────────────────────────

  {
    id: "deploy",
    label: "Deploy",
    description: "Ship to production",
    iconKey: "rocket",
    severity: "normal",
    context: "workspace",
    integrationCategory: "deploy",
    gateType: "deploy",
  },
  {
    id: "git-push",
    label: "Git Sync",
    description: "Push code to remote",
    iconKey: "git-branch",
    severity: "normal",
    context: "workspace",
    integrationCategory: "git",
    gateType: "git",
  },
  {
    id: "db-push",
    label: "DB Push",
    description: "Push schema migrations to database",
    iconKey: "layers",
    severity: "warning",
    context: "workspace",
    integrationCategory: "data",
    gateType: "db_migrate",
    requiresConfirmation: true,
  },

  // ── Database context ───────────────────────────────────────────────────

  {
    id: "db-drop-table",
    label: "Drop Table",
    description: "Permanently delete this table and all its data",
    iconKey: "trash",
    severity: "destructive",
    context: "database",
    integrationCategory: "data",
    gateType: "db_migrate",
    requiresSelection: "table",
    requiresConfirmation: true,
  },
  {
    id: "db-truncate-table",
    label: "Truncate",
    description: "Remove all rows from this table",
    iconKey: "trash",
    severity: "destructive",
    context: "database",
    integrationCategory: "data",
    gateType: "db_write",
    requiresSelection: "table",
    requiresConfirmation: true,
  },
  {
    id: "db-backup",
    label: "Backup",
    description: "Create a snapshot of the current database state",
    iconKey: "shield",
    severity: "normal",
    context: "database",
    integrationCategory: "data",
    gateType: "db_read",
  },
  {
    id: "db-restore",
    label: "Restore",
    description: "Restore database from a previous backup",
    iconKey: "activity",
    severity: "destructive",
    context: "database",
    integrationCategory: "data",
    gateType: "db_write",
    requiresConfirmation: true,
  },
  {
    id: "db-run-migration",
    label: "Run Migration",
    description: "Execute pending database migrations",
    iconKey: "layers",
    severity: "warning",
    context: "database",
    integrationCategory: "data",
    gateType: "db_migrate",
    requiresConfirmation: true,
  },

  // ── Integrations context ───────────────────────────────────────────────

  {
    id: "db-provision",
    label: "Provision Database",
    description: "Create a new database on the connected provider",
    iconKey: "table",
    severity: "normal",
    context: "integrations",
    integrationCategory: "data",
    gateType: "db_write",
  },
  {
    id: "credentials-sync",
    label: "Sync Credentials",
    description: "Sync provider credentials to sandbox environment",
    iconKey: "key",
    severity: "normal",
    context: "integrations",
    integrationCategory: "data",
    gateType: "env",
  },
];
