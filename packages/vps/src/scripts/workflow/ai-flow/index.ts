// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * AI flow script - context-aware save and ship operations.
 *
 * @param apiUrl - The ellul API URL
 */
import skeleton from '@vps/templates/workflow/ai-flow/ai-flow.sh';
import {
  refresh_context,
  ensure_gitignore,
  select_project,
  find_available_port,
  get_app_name,
  get_existing_deployment,
} from "./helpers.js";
import {
  cmd_save,
  cmd_ship,
  cmd_ship_update,
  cmd_ship_manual,
  cmd_help,
} from "./commands.js";

export function getAiFlowScript(apiUrl: string): string {
  return skeleton
    .replace('__API_URL__', () => apiUrl)
    .replace('__REFRESH_CONTEXT__', () => refresh_context())
    .replace('__ENSURE_GITIGNORE__', () => ensure_gitignore())
    .replace('__CMD_SAVE__', () => cmd_save())
    .replace('__SELECT_PROJECT__', () => select_project())
    .replace('__FIND_AVAILABLE_PORT__', () => find_available_port())
    .replace('__GET_APP_NAME__', () => get_app_name())
    .replace('__GET_EXISTING_DEPLOYMENT__', () => get_existing_deployment())
    .replace('__CMD_SHIP__', () => cmd_ship())
    .replace('__CMD_SHIP_UPDATE__', () => cmd_ship_update())
    .replace('__CMD_SHIP_MANUAL__', () => cmd_ship_manual())
    .replace('__CMD_HELP__', () => cmd_help());
}
