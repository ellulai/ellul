// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type {
  EnvironmentId,
  ProjectSearchEntriesResult,
  ClientOrchestrationCommand,
} from "@ellul.ai/types";
import type { WsRpcClient } from "./ws-rpc-client";

export interface EnvironmentApi {
  readonly projects: {
    searchEntries(input: {
      cwd: string;
      query: string;
      limit: number;
    }): Promise<ProjectSearchEntriesResult>;
  };
  readonly orchestration: {
    dispatchCommand: (input: ClientOrchestrationCommand) => Promise<unknown>;
  };
}

const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};

let activeClient: WsRpcClient | null = null;

export function setActiveEnvironmentClient(client: WsRpcClient | null): void {
  activeClient = client;
}

export function readEnvironmentApi(_environmentId: EnvironmentId): EnvironmentApi | undefined {
  if (!activeClient) return undefined;
  const client = activeClient;
  return {
    projects: { searchEntries: async () => EMPTY_SEARCH_ENTRIES_RESULT },
    orchestration: { dispatchCommand: (input) => client.dispatchCommand(input) },
  };
}

export function ensureEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi {
  const api = readEnvironmentApi(environmentId);
  if (!api) throw new Error(`Environment API not available for ${environmentId}`);
  return api;
}
