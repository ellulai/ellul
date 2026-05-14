// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts

import { Effect, Layer, PubSub, Stream } from "effect";

import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
  type RuntimeReceiptBusShape,
} from "../Services/RuntimeReceiptBus";

const makeRuntimeReceiptBus = Effect.succeed({
  publish: () => Effect.void,
  streamEventsForTest: Stream.empty,
} satisfies RuntimeReceiptBusShape);

const makeRuntimeReceiptBusTest = Effect.gen(function* () {
  const pubSub = yield* PubSub.unbounded<OrchestrationRuntimeReceipt>();

  return {
    publish: (receipt) => PubSub.publish(pubSub, receipt).pipe(Effect.asVoid),
    get streamEventsForTest() {
      return Stream.fromPubSub(pubSub);
    },
  } satisfies RuntimeReceiptBusShape;
});

export const RuntimeReceiptBusLive = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBus);
export const RuntimeReceiptBusTest = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBusTest);
