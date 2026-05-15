// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/provider/{Services,Layers}/ProviderRegistry.ts
//
// Simplified vs. upstream: no on-disk status cache (we load fresh each
// boot), no model-capability merge across snapshots. Public interface
// matches upstream so transport/UI wiring is identical.

import type { ProviderKind, ServerProvider } from "@ellul.ai/types";
import { Context, Effect, Equal, Layer, PubSub, Ref, Stream } from "effect";

import { ClaudeProvider, ClaudeProviderLive } from "../adapters/claude/provider";
import { CodexProvider, CodexProviderLive } from "../adapters/codex/provider";
import { CursorProvider, CursorProviderLive } from "../adapters/cursor/provider";
import { OpenCodeProvider, OpenCodeProviderLive } from "../adapters/opencode/provider";
import { OpenCodeRuntimeLive } from "../adapters/opencode/runtime";
import { ZeroClawProvider, ZeroClawProviderLive } from "../adapters/zeroclaw/provider";
import { ZeroClawRuntimeLive } from "../adapters/zeroclaw/runtime";
import { GrokProvider, GrokProviderLive } from "../adapters/grok/provider";

export interface ProviderRegistryShape {
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly refresh: (provider?: ProviderKind) => Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
}

export class ProviderRegistry extends Context.Service<ProviderRegistry, ProviderRegistryShape>()(
  "agent-bridge/ProviderRegistry",
) {}

type ProviderSource = {
  readonly provider: ProviderKind;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
};

const PROVIDER_ORDER: ReadonlyArray<ProviderKind> = [
  "codex",
  "claudeAgent",
  "opencode",
  "cursor",
  "zeroclaw",
  "grokAgent",
];

const orderByProvider = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> => {
  const byProvider = new Map(providers.map((p) => [p.provider, p] as const));
  const ordered: ServerProvider[] = [];
  for (const provider of PROVIDER_ORDER) {
    const entry = byProvider.get(provider);
    if (entry) ordered.push(entry);
  }
  return ordered;
};

const ProviderRegistryLiveBase = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const codex = yield* CodexProvider;
    const claude = yield* ClaudeProvider;
    const opencode = yield* OpenCodeProvider;
    const cursor = yield* CursorProvider;
    const zeroclaw = yield* ZeroClawProvider;
    const grok = yield* GrokProvider;

    const sources: ReadonlyArray<ProviderSource> = [
      {
        provider: "codex",
        getSnapshot: codex.getSnapshot,
        refresh: codex.refresh,
        streamChanges: codex.streamChanges,
      },
      {
        provider: "claudeAgent",
        getSnapshot: claude.getSnapshot,
        refresh: claude.refresh,
        streamChanges: claude.streamChanges,
      },
      {
        provider: "opencode",
        getSnapshot: opencode.getSnapshot,
        refresh: opencode.refresh,
        streamChanges: opencode.streamChanges,
      },
      {
        provider: "cursor",
        getSnapshot: cursor.getSnapshot,
        refresh: cursor.refresh,
        streamChanges: cursor.streamChanges,
      },
      {
        provider: "zeroclaw",
        getSnapshot: zeroclaw.getSnapshot,
        refresh: zeroclaw.refresh,
        streamChanges: zeroclaw.streamChanges,
      },
      {
        provider: "grokAgent",
        getSnapshot: grok.getSnapshot,
        refresh: grok.refresh,
        streamChanges: grok.streamChanges,
      },
    ];

    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );

    const initial = yield* Effect.forEach(sources, (s) => s.getSnapshot, {
      concurrency: "unbounded",
    }).pipe(Effect.map(orderByProvider));

    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(initial);

    const syncProvider = (next: ServerProvider) =>
      Effect.gen(function* () {
        const [prev, updated] = yield* Ref.modify(providersRef, (current) => {
          const merged = new Map(current.map((p) => [p.provider, p] as const));
          merged.set(next.provider, next);
          const ordered = orderByProvider([...merged.values()]);
          return [[current, ordered] as const, ordered];
        });
        if (!Equal.equals(prev, updated)) {
          yield* PubSub.publish(changesPubSub, updated);
        }
        return updated;
      });

    yield* Effect.forEach(
      sources,
      (source) =>
        Stream.runForEach(source.streamChanges, (provider) => syncProvider(provider)).pipe(
          Effect.forkScoped,
        ),
      { concurrency: "unbounded", discard: true },
    );

    const refresh = (provider?: ProviderKind) =>
      Effect.gen(function* () {
        if (provider) {
          const source = sources.find((s) => s.provider === provider);
          if (!source) return yield* Ref.get(providersRef);
          const next = yield* source.refresh;
          return yield* syncProvider(next);
        }
        yield* Effect.forEach(
          sources,
          (source) => source.refresh.pipe(Effect.flatMap(syncProvider)),
          { concurrency: "unbounded", discard: true },
        );
        return yield* Ref.get(providersRef);
      }).pipe(
        Effect.tapError(Effect.logError),
        Effect.orElseSucceed(() => [] as ReadonlyArray<ServerProvider>),
      );

    return {
      getProviders: Ref.get(providersRef),
      refresh,
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
);

export const ProviderRegistryLive = ProviderRegistryLiveBase.pipe(
  Layer.provideMerge(CursorProviderLive),
  Layer.provideMerge(CodexProviderLive),
  Layer.provideMerge(ClaudeProviderLive),
  Layer.provideMerge(OpenCodeProviderLive),
  Layer.provideMerge(OpenCodeRuntimeLive),
  Layer.provideMerge(ZeroClawProviderLive),
  Layer.provideMerge(ZeroClawRuntimeLive),
  Layer.provideMerge(GrokProviderLive),
);
