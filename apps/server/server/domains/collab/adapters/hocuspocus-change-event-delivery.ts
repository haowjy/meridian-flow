/** Delivers committed change events to connected clients in live document rooms. */

import type { Connection, Hocuspocus } from "@hocuspocus/server";
import { encodeChangeEventWsMessage } from "@meridian/contracts/protocol";
import type { UserId } from "@meridian/contracts/runtime";
import type { EventSink } from "../../observability/index.js";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { projectChangeEventForRecipient } from "../domain/change-event-projection.js";
import type { ChangeEventDelivery } from "../domain/ports/change-event-delivery.js";

export function createHocuspocusChangeEventDelivery(input: {
  hocuspocus: () => Hocuspocus;
  eventSink?: EventSink;
}): ChangeEventDelivery {
  return {
    deliver(message, sweptChanges) {
      try {
        // A live room is named by the bare document ID. Branch review rooms use
        // the branch: prefix and intentionally receive attributed decorations elsewhere.
        const room = input.hocuspocus().documents.get(message.documentId);
        if (!room) return;
        const connectionsByUser = new Map<UserId | null, Set<Connection>>();
        for (const connection of room.getConnections()) {
          const rawUserId = (connection.context as { userId?: unknown }).userId;
          const userId = typeof rawUserId === "string" ? (rawUserId as UserId) : null;
          const connections = connectionsByUser.get(userId) ?? new Set<Connection>();
          connections.add(connection);
          connectionsByUser.set(userId, connections);
        }
        for (const [userId, connections] of connectionsByUser) {
          const payload = encodeChangeEventWsMessage(
            projectChangeEventForRecipient(message, sweptChanges, userId),
          );
          room.broadcastStateless(payload, (connection) => connections.has(connection));
        }
      } catch (cause) {
        if (!input.eventSink) return;
        emitEvent(input.eventSink, {
          level: "warn",
          source: "collab.change_event",
          name: "change_event.delivery_failed",
          payload: {
            documentId: message.documentId,
            trailId: message.trailId,
            ...unknownToEventPayload(cause),
          },
        });
      }
    },
  };
}
