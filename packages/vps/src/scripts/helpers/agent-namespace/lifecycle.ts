// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Lifecycle case blocks for the agent-namespace script.
 * Each function returns the bash code for one case in the main switch.
 *
 * Re-exports from lifecycle/ submodules.
 */

export { setupBlock } from './lifecycle/setup';
export { enterBlock } from './lifecycle/enter';
export { teardownBlock } from './lifecycle/teardown';
export { spawnBlock } from './lifecycle/spawn';
