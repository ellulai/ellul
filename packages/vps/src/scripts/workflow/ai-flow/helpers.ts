// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * AI flow helper functions — each returns a bash function body.
 */

import refreshContextContent from '@vps/shell/workflow/ai-flow/helpers/refresh-context.sh';
import ensureGitignoreContent from '@vps/shell/workflow/ai-flow/helpers/ensure-gitignore.sh';
import selectProjectContent from '@vps/shell/workflow/ai-flow/helpers/select-project.sh';
import findPortContent from '@vps/shell/workflow/ai-flow/helpers/find-port.sh';
import getAppNameContent from '@vps/shell/workflow/ai-flow/helpers/get-app-name.sh';
import getDeploymentContent from '@vps/shell/workflow/ai-flow/helpers/get-deployment.sh';

export function refresh_context(): string {
  return refreshContextContent;
}

export function ensure_gitignore(): string {
  return ensureGitignoreContent;
}

export function select_project(): string {
  return selectProjectContent;
}

export function find_available_port(): string {
  return findPortContent;
}

export function get_app_name(): string {
  return getAppNameContent;
}

export function get_existing_deployment(): string {
  return getDeploymentContent;
}
