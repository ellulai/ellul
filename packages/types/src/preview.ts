// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Preview control-plane types — the single source of truth for the state
 * model shared between the VPS (file-api, agent-bridge) and the browser
 * console (Next.js app).
 *
 * Adding a new phase, probe state, or orphan reason? Add it here first.
 * Both sides compile against this file; a missing case in the console
 * becomes a TS error at build time instead of a silent placeholder in
 * production.
 */

/**
 * Why the port/systemd relationship is (or isn't) an orphan. Used by the
 * orphan classifier and surfaced to the UI via PreviewHealthResult.orphanReason.
 */
export type OrphanReason =
  | 'no_listener'        // no process on the port — not an orphan
  | 'unit_active'        // systemd unit is running and owns the port
  | 'unit_activating'    // unit is starting up; port may be bound by it
  | 'foreign_user'       // port held by a process not owned by SVC_USER
  | 'unknown_cmdline'    // cmdline doesn't match any known dev-server
  | 'port_out_of_range'  // port is outside the preview allocation window
  | 'orphan_healable';   // our user, known dev-server cmdline, unit inactive

/**
 * Health phase returned by `getPreviewHealth`. Every case has a distinct UI
 * render so the console never falls back to a generic placeholder.
 *
 * Progression on a cold start:
 *
 *   idle → installing → starting → compiling → ready
 *
 * `starting` and `compiling` are distinct because they answer different
 * questions for the user:
 *
 *   starting  — "we're spinning up the unit" (systemd activating, port not
 *               yet bound). Short-lived, usually under a second.
 *   compiling — "the server is bound and accepting TCP, but its first HTTP
 *               response is pending" (Next.js/Vite/Spring Boot first-
 *               request compile, Rails eager load, Flask reloader). Can
 *               last 30-90s on the first cold start; the console surfaces
 *               a framework-aware "Building bundle…" panel so the user
 *               knows the wait is expected progress, not a hang.
 *   ready     — HTTP probe succeeded at least once; the iframe mounts
 *               against the dev domain.
 */
export type PreviewPhase =
  | 'idle'
  | 'installing'
  | 'starting'
  | 'compiling'
  | 'ready'
  | 'error'
  | 'crashed'
  | 'orphan';

/**
 * Fine-grained phases emitted during a preview start via the
 * `preview_install_status` WebSocket broadcast. Distinct from PreviewPhase,
 * which is the aggregate health snapshot — lifecycle phases are transitional
 * events (the broadcast happens at the moment a phase is entered), whereas
 * PreviewPhase is a sampled state (what the probe observes right now).
 *
 * Both the backend's lifecycle emitter and the console's WS subscriber
 * compile against this union; adding a new phase without updating every
 * switch/map on either side is a type error.
 */
export type PreviewLifecyclePhase =
  // Progress phases — UI-annotation events only. The aggregate health is
  // unchanged at these points, so no `preview_all_status` broadcast pairs.
  | 'installing_runtime'
  | 'installing_deps'
  | 'starting_server'
  // Transition phases — represent a canonical health state change. Paired
  // with a `preview_all_status` broadcast so cache-driven consumers stay in
  // lockstep. Consumers that invalidate their cache on lifecycle events
  // should do so ONLY for these phases.
  | 'runtime_installed'
  | 'runtime_failed'
  | 'deps_installed'
  | 'deps_failed'
  | 'ready';

/**
 * Subset of PreviewLifecyclePhase that denotes a canonical state change
 * (as opposed to UI-only progress). Runtime constant so it's usable as a
 * set membership check on both sides.
 */
export const CANONICAL_PREVIEW_PHASES: ReadonlySet<PreviewLifecyclePhase> = new Set<PreviewLifecyclePhase>([
  'runtime_installed',
  'runtime_failed',
  'deps_installed',
  'deps_failed',
  'ready',
]);

/**
 * Payload of a `preview_install_status` WebSocket message — the granular
 * lifecycle stream consumed by the console for toasts, iframe remounts, and
 * cache invalidation.
 */
export interface PreviewLifecycleEvent {
  app: string;
  phase: PreviewLifecyclePhase;
  message: string;
  /** Present only for runtime_* phases; the runtime being installed. */
  runtime?: string;
}

/**
 * Health state returned by `probePreview`. Narrower than PreviewPhase because
 * the probe is agent-facing (not UI) and cares about correctness of the
 * Caddy → dev-server path, not unit installation state.
 */
export type ProbeHealthState =
  | 'warming'
  | 'ok'
  | 'blocked'
  | 'unreachable'
  | 'orphan';

/**
 * Full health record surfaced by file-api's `/api/preview/health`. Console
 * maps this 1:1 to UI views.
 */
export interface PreviewHealthResult {
  phase: PreviewPhase;
  app: string | null;
  active: boolean;
  port: number;
  error?: string;
  logTail?: string;
  healAttempts?: number;
  healStatus?: 'healing' | 'exhausted' | null;
  openApi?: { docsPath: string | null; specPath: string | null };
  /** Server runs but console should not render a preview panel. */
  headless?: boolean;
  /** Set when the launcher fell back to npm-run-dev because no spec was committed. */
  specMissing?: boolean;
  /** Human action hint — displayed by the UI alongside a Restart button. */
  recoveryHint?: string;
  /** Present when phase === 'error': last HTTP status (4xx/5xx). */
  httpStatus?: number;
  /** Present when phase === 'orphan': why we couldn't auto-heal. */
  orphanReason?: OrphanReason;
  /**
   * Present when phase === 'crashed' to disambiguate the failure shape so
   * the console can render the right affordance. `install_failed` enables
   * the "Ask assistant to fix" button which hands the npm log tail to the
   * chat iframe as diagnostic context.
   */
  failReason?: 'install_failed' | 'unit_failed';
}

/**
 * Two-phase probe result. Agent-facing; the `preview_verify` builtin tool
 * returns a subset of this with cache metadata added.
 */
export interface PreviewProbeResult {
  healthState: ProbeHealthState;
  httpStatus: number | null;
  contentHash: string | null;
  warnings: string[];
  devDomain: string | null;
  port: number;
  durationMs: number;
}
