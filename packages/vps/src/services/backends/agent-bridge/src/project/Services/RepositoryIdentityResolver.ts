// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/project/Services/RepositoryIdentityResolver.ts

import type { RepositoryIdentity } from "@ellul.ai/types";
import { Context } from "effect";
import type { Effect } from "effect";

export interface RepositoryIdentityResolverShape {
  readonly resolve: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  RepositoryIdentityResolverShape
>()("t3/project/Services/RepositoryIdentityResolver") {}
