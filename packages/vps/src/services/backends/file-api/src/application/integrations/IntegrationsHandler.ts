// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Pure handler for the chat Actions dropdown endpoints.

import * as path from 'path';
import type { IntegrationsResponse } from '@ellul.ai/types';
import { ROOT_DIR } from '../../config';
import {
  getIntegrations,
  invalidateIntegrationsCache,
} from './Integrations';

export type HandlerResult<T> =
  | { status: 200; body: T }
  | { status: 400 | 404 | 502; body: { error: string } };

// Resolve the project directory (sandbox-relative) for the given identifier
export type ResolveProjectDir = (identifier: string) => string | null;

export async function handleGetIntegrations(
  appIdentifier: string,
  resolveProjectDir: ResolveProjectDir,
): Promise<HandlerResult<IntegrationsResponse>> {
  if (!appIdentifier) {
    return { status: 400, body: { error: 'Missing app identifier' } };
  }
  const resolvedRel = resolveProjectDir(appIdentifier);
  if (!resolvedRel) {
    return { status: 404, body: { error: 'App not found' } };
  }
  const absoluteDir = path.join(ROOT_DIR, resolvedRel);
  try {
    const response = await getIntegrations(resolvedRel, absoluteDir);
    return { status: 200, body: response };
  } catch (err) {
    return {
      status: 502,
      body: {
        error: `Failed to resolve integrations: ${(err as Error).message}`,
      },
    };
  }
}

export function handleInvalidateIntegrations(
  appIdentifier: string,
  resolveProjectDir: ResolveProjectDir,
): HandlerResult<{ ok: true }> {
  if (!appIdentifier) {
    return { status: 400, body: { error: 'Missing app identifier' } };
  }
  const resolvedRel = resolveProjectDir(appIdentifier);
  if (!resolvedRel) {
    return { status: 404, body: { error: 'App not found' } };
  }
  invalidateIntegrationsCache(resolvedRel);
  return { status: 200, body: { ok: true } };
}
