/** Delivers committed change events to connected clients in live document rooms. */

import type { Hocuspocus } from "@hocuspocus/server";
import { encodeChangeEventWsMessage } from "@meridian/contracts/protocol";
import type { EventSink } from "../../observability/index.js";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { ChangeEventDelivery } from "../domain/ports/change-event-delivery.js";

export function createHocuspocusChangeEventDelivery(input: {
  hocuspocus: () => Hocuspocus;
  eventSink?: EventSink;
}): ChangeEventDelivery {
  return {
    deliver(message) {
      try {
        // A live room is named by the bare document ID. Branch review rooms use
        // the branch: prefix and intentionally receive attributed decorations elsewhere.
        const room = input.hocuspocus().documents.get(message.documentId);
        if (!room || room.getConnectionsCount() === 0) return;
        room.broadcastStateless(encodeChangeEventWsMessage(message));
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
