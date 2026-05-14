// SPDX-License-Identifier: MIT

// Database Migration Workflow -- Chat-Initiated

// Commands that trigger migration workflows in chat
export const MIGRATION_COMMANDS = {
  // Preview and apply schema changes
  DB_PUSH: "/db-push",
  // Drop a specific table (with confirmation)
  DB_DROP_TABLE: "/db-drop-table",
  // Truncate a specific table
  DB_TRUNCATE: "/db-truncate",
  // Restore from backup
  DB_RESTORE: "/db-restore",
} as const;

// Metadata attached to migration command messages
export interface MigrationCommandMetadata {
  [key: string]: unknown;
  source: "action-button";
  action: string;
  project: string | null;
  table?: string;
}

// Build a migration command string for the chat.
export function buildMigrationCommand(
  command: string,
  options: {
    project?: string | null;
    table?: string | null;
  } = {},
): string {
  let cmd = command;
  if (options.table) cmd += ` ${options.table}`;
  if (options.project) cmd += ` --project ${options.project}`;
  return cmd;
}

// Build the metadata object for a migration command message.
export function buildMigrationMetadata(
  action: string,
  project: string | null,
  table?: string,
): MigrationCommandMetadata {
  return {
    source: "action-button",
    action,
    project,
    ...(table && { table }),
  };
}
