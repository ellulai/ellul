// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { Effect, Option, Ref } from "effect";
import type { ProviderKind, ThreadId } from "@ellul.ai/types";
import {
  type ProviderRuntimeBinding,
  type ProviderRuntimeBindingWithMetadata,
  type ProviderSessionDirectoryShape,
} from "./session-directory";
import {
  makeSessionCheckpointService,
  type CheckpointAdapter,
  type SessionCheckpointService,
} from "../application/runtime-control/SessionCheckpointService";
import { logEvent } from "../shared/event-log";

let cachedSvc: SessionCheckpointService | null = null;
function getCheckpointService(): SessionCheckpointService {
  if (cachedSvc) return cachedSvc;
  cachedSvc = makeSessionCheckpointService({
    emit: (e) => logEvent("checkpoint.event", e as unknown as Record<string, unknown>),
  });
  return cachedSvc;
}

/**
 * Test affordance: override the cached checkpoint service so tests can
 * use a tmpdir-backed instance without monkey-patching DEFAULT_VAULT.
 * Production callers must NOT use this.
 */
export function __TEST_setCheckpointService(svc: SessionCheckpointService | null): void {
  cachedSvc = svc;
}

const ADAPTER_MAP: Record<string, CheckpointAdapter | undefined> = {
  claude: "claude",
  opencode: "opencode",
  cursor: "cursor",
  codex: "codex",
};

function adapterFor(provider: ProviderKind): CheckpointAdapter | null {
  return ADAPTER_MAP[provider as string] ?? null;
}

/**
 * Rehydrate the in-memory ref from the vault on bridge boot.
 *
 * Without this, a bridge restart leaves every thread's adapter binding
 * with no in-memory state until the user sends another message — which
 * surfaces in the UI as "Provider is not ready" or threads that need to
 * re-spawn from cold. The vault has the same data we just wrote on the
 * previous run; load it once at construction time and the directory is
 * warm before the first WebSocket client subscribes.
 *
 * Errors are swallowed: a corrupt checkpoint file shouldn't take down
 * the whole directory. Each thread is loaded independently; one bad
 * file just means that thread starts cold (which is the previous
 * behaviour).
 */
async function rehydrateFromVault(
  svc: ReturnType<typeof getCheckpointService>,
): Promise<{
  bindings: Array<[string, ProviderRuntimeBindingWithMetadata]>;
  turns: Array<[string, number]>;
}> {
  const bindings: Array<[string, ProviderRuntimeBindingWithMetadata]> = [];
  const turns: Array<[string, number]> = [];
  let entries: Awaited<ReturnType<typeof svc.list>> = [];
  try {
    entries = await svc.list();
  } catch (err) {
    logEvent("checkpoint.rehydrate.listError", {
      message: err instanceof Error ? err.message : String(err),
    });
    return { bindings, turns };
  }
  for (const entry of entries) {
    try {
      const cp = await svc.load(entry.threadId);
      if (!cp) continue;
      const payload = (cp.payload ?? {}) as {
        resumeCursor?: unknown;
        runtimePayload?: unknown;
        status?: "starting" | "running" | "stopped" | "error";
        adapterKey?: string | null;
      };
      // CheckpointAdapter values (claude|opencode|cursor|codex) are also
      // valid ProviderKind values for the four standard adapters. The
      // writeCheckpoint side maps ProviderKind → CheckpointAdapter via
      // ADAPTER_MAP and only writes when the mapping exists, so any
      // adapter value coming back out is round-trippable here.
      const binding: ProviderRuntimeBindingWithMetadata = {
        threadId: entry.threadId as ThreadId,
        provider: cp.adapter as ProviderKind,
        adapterKey: payload.adapterKey ?? undefined,
        status: payload.status ?? "running",
        resumeCursor: payload.resumeCursor ?? null,
        runtimePayload: payload.runtimePayload ?? null,
        lastSeenAt: new Date(entry.updatedAt).toISOString(),
      };
      bindings.push([entry.threadId, binding]);
      turns.push([entry.threadId, entry.turn]);
    } catch (err) {
      logEvent("checkpoint.rehydrate.loadError", {
        threadId: entry.threadId,
        adapter: entry.adapter,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (bindings.length > 0) {
    logEvent("checkpoint.rehydrate.ok", {
      count: bindings.length,
      threadIds: bindings.map(([id]) => id),
    });
  }
  return { bindings, turns };
}

export const makeProviderSessionDirectoryVaultBacked = (): Effect.Effect<ProviderSessionDirectoryShape> =>
  Effect.gen(function* () {
    const svc = getCheckpointService();
    // Eagerly load every previously-persisted binding from the vault so
    // the directory is warm before clients connect. See rehydrateFromVault
    // for the boot-path contract.
    const initial = yield* Effect.promise(() => rehydrateFromVault(svc));
    const ref = yield* Ref.make(
      new Map<string, ProviderRuntimeBindingWithMetadata>(initial.bindings),
    );
    const turnRef = yield* Ref.make(new Map<string, number>(initial.turns));
    const nowIso = () => new Date().toISOString();

    // writeCheckpoint persists a binding to the vault when it has enough
    // state to be resumable across a bridge restart. Bindings that have
    // just transitioned to status="starting" (created by the adapter
    // BEFORE the underlying provider session.create returns) carry no
    // sessionId yet — there is nothing useful to write. Persisting an
    // empty checkpoint would either:
    //   - overwrite a previously-good entry with a useless one, or
    //   - waste an fsync on a binding that will be re-upserted with the
    //     real sessionId milliseconds later.
    //
    // The previous design failed the upsert Effect when sessionId was
    // missing. That cascaded into the caller (provider-service
    // startSession), which propagated through the WebSocket handler and
    // surfaced as "first message fails" — every fresh thread paid the
    // failure on its initial status="starting" upsert. The fix:
    // skip-and-log on missing sessionId. The next upsert that carries a
    // sessionId persists the resumable state; the in-memory ref is
    // always updated by the caller (we never block on disk for that).
    //
    // Errors writing the checkpoint (disk full, EACCES, etc.) are also
    // logged but never re-thrown. Vault is best-effort durability; the
    // live request path is the in-memory map.
    const writeCheckpoint = (binding: ProviderRuntimeBinding): Effect.Effect<void> =>
      Effect.promise(async () => {
        const adapter = adapterFor(binding.provider);
        if (!adapter) {
          logEvent("checkpoint.skip", {
            threadId: String(binding.threadId),
            provider: String(binding.provider),
            reason: "unknown-provider",
          });
          return;
        }
        const sessionId = extractSessionId(binding);
        if (!sessionId) {
          // Expected for the initial status="starting" upsert; the next
          // upsert (with sessionId populated) will persist.
          logEvent("checkpoint.skip", {
            threadId: String(binding.threadId),
            provider: String(binding.provider),
            status: binding.status ?? null,
            reason: "no-session-id",
          });
          return;
        }
        try {
          const turn = await Ref.get(turnRef).pipe(
            Effect.map((m) => (m.get(binding.threadId as string) ?? 0) + 1),
            Effect.runPromise,
          );
          await Ref.update(turnRef, (m) => {
            const next = new Map(m);
            next.set(binding.threadId as string, turn);
            return next;
          }).pipe(Effect.runPromise);
          await svc.checkpoint(
            binding.threadId as string,
            adapter,
            {
              resumeCursor: binding.resumeCursor ?? null,
              runtimePayload: binding.runtimePayload ?? null,
              status: binding.status ?? "running",
              adapterKey: binding.adapterKey ?? null,
            },
            sessionId,
            turn,
          );
        } catch (err) {
          // Disk error — log and swallow. The in-memory map already has
          // the binding; subsequent upserts will retry.
          logEvent("checkpoint.writeError", {
            threadId: String(binding.threadId),
            provider: String(binding.provider),
            adapter,
            message: err instanceof Error ? err.message : String(err),
            code: (err as NodeJS.ErrnoException).code ?? null,
          });
        }
      });

    return {
      upsert: (binding) =>
        Ref.update(ref, (map) => {
          const next = new Map(map);
          next.set(binding.threadId, { ...binding, lastSeenAt: nowIso() });
          return next;
        }).pipe(Effect.flatMap(() => writeCheckpoint(binding))),
      remove: (threadId) =>
        Ref.update(ref, (map) => {
          if (!map.has(threadId)) return map;
          const next = new Map(map);
          next.delete(threadId);
          return next;
        }).pipe(
          Effect.flatMap(() => Effect.promise(() => svc.forget(threadId as string))),
        ),
      getProvider: (threadId) =>
        Ref.get(ref).pipe(
          Effect.map((map) => {
            const v = map.get(threadId)?.provider;
            return v === undefined ? Option.none() : Option.some(v);
          }),
        ),
      getBinding: (threadId) =>
        Ref.get(ref).pipe(
          Effect.map((map) => {
            const v = map.get(threadId);
            return v === undefined ? Option.none() : Option.some(v);
          }),
        ),
      listThreadIds: () =>
        Ref.get(ref).pipe(Effect.map((map) => Array.from(map.keys()) as unknown as ReadonlyArray<ThreadId>)),
      listBindings: () => Ref.get(ref).pipe(Effect.map((map) => Array.from(map.values()))),
    } satisfies ProviderSessionDirectoryShape;
  });

function extractSessionId(binding: ProviderRuntimeBinding): string | null {
  const cursor = binding.resumeCursor as { sessionId?: unknown; resume?: unknown } | null | undefined;
  if (cursor && typeof cursor.sessionId === "string") return cursor.sessionId;
  if (cursor && typeof cursor.resume === "string") return cursor.resume;
  const payload = binding.runtimePayload as { sessionId?: unknown } | null | undefined;
  if (payload && typeof payload.sessionId === "string") return payload.sessionId;
  if (binding.adapterKey && binding.adapterKey.length > 0) return binding.adapterKey;
  return null;
}
