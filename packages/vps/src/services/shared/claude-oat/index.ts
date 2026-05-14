// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Public barrel for the shared Claude OAT bounded-context vocabulary.
 *
 * Consumers (sovereign-shield, agent-bridge, ellul-claude-launch) import
 * from `@vps/shared/claude-oat` — this barrel keeps the surface area
 * tight and makes refactors inside the module non-breaking.
 */

export * from "./domain-types";
export * from "./policy";
export * from "./protocol";
export * from "./routes";
