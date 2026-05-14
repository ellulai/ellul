/**
 * Integration and deployment provider types.
 *
 * Shared between the API (publish orchestration) and the console UI
 * (deployment status display, provider capability checks).
 */

/** Deployment lifecycle status */
export type DeploymentStatus = "queued" | "building" | "ready" | "error" | "canceled";

/** What a deployment provider supports */
export interface ProviderCapabilities {
  logs: boolean;
  cancel: boolean;
  rollback: boolean;
  previewEnvironments: boolean;
  customDomainsManaged: boolean;
  envVarSync: boolean;
}
