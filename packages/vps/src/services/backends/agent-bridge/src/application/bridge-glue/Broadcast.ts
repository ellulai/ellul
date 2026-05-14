// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { Server as HttpServer } from "http";
import { broadcastToAllSessions } from "../../internal-http/session-registry";
import type { BroadcastSink } from "../../composition/runtime-control/RuntimeControlLayer";

export function makeBridgeBroadcast(httpServer: HttpServer): BroadcastSink {
  let acceptsClosed = false;
  httpServer.on("upgrade", (req, socket) => {
    if (acceptsClosed) {
      try {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n");
        socket.destroy();
      } catch { /* socket already gone */ }
    }
  });
  return {
    broadcastShutdown(payload) { broadcastToAllSessions(payload); },
    closeWsAccepts() { acceptsClosed = true; },
    broadcastSystemHealth(snap) { broadcastToAllSessions({ event: "system_health_update", snap }); },
    broadcastSlotUpdate(slots) { broadcastToAllSessions({ event: "pro_claude_slot_update", slots }); },
    broadcastQueueUpdate(queues) { broadcastToAllSessions({ event: "inference_queue_update", queues }); },
  };
}
