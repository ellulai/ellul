// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Canonical ellul branded-landing copy — the single source of
 * truth for the text shown on every scaffolded app's first-render
 * page.
 *
 * The classList + DOM shape lives baked into each framework's tree
 * (`trees/<id>/…`) because tree files are the deployable artefact —
 * pure data, reviewable, no runtime composition. The TEXT lives here
 * so a one-line edit can be enforced consistent across every tree:
 * the coherence test asserts every frontend tree's landing file
 * contains these exact strings. Drift → failing test → file pointers
 * show you where to edit.
 */

export const LANDING_COPY = {
  /** Small uppercase wordmark above the heading. */
  badge: 'ellul',
  /** Primary heading. */
  heading: 'Your app is ready.',
  /** Sub-heading below the heading. */
  subtitle: 'Ask the agent to build, or edit this page to start shipping.',
  /** Card titles + hints under the heading. */
  actions: [
    { title: 'Edit', hint: 'Change this file, see it live.' },
    { title: 'Chat', hint: 'Ask the agent to build features.' },
  ],
} as const;

/** Every line of branded copy, flat — useful for tree-coverage tests. */
export function allLandingPhrases(): readonly string[] {
  const base: string[] = [LANDING_COPY.badge, LANDING_COPY.heading, LANDING_COPY.subtitle];
  for (const a of LANDING_COPY.actions) {
    base.push(a.title, a.hint);
  }
  return base;
}
