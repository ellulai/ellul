/**
 * Gate type definitions.
 *
 * Used by both the console UI (gate monitor, permission UI) and the VPS
 * (sovereign-shield gate service, gate-permissions service).
 */

/** All gate types supported by sovereign-shield */
export type GateType =
  | "logs"
  | "env"
  | "db_read"
  | "db_write"
  | "db_migrate"
  | "git"
  | "deploy"
  | "exec"
  | "wallet_spend"
  | "vault_read";

/** Per-gate permission policy */
export type GatePermission = "ask" | "allow_session" | "allow_always" | "never";
