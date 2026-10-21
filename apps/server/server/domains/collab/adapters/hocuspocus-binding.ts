/** Mutable Hocuspocus instance binding and draft-room delivery and repair. */
import type { Hocuspocus, TransactionOrigin } from "@hocuspocus/server";
import * as Y from "yjs";
import type { EventSink } from "../../observability/index.js";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { closeDraftRooms } from "../hocuspocus-rooms.js";

const DRAFT_AGENT_BROADCAST_ORIGIN = {
  source: "local",
  context: { origin: { type: "system", reason: "draft-agent-append" } },
} satisfies TransactionOrigin;

/** Content a draft room did not author: Hocuspocus broadcasts it to the room's tabs. */
function applyToRoom(room: Y.Doc, update: Uint8Array): void {
  Y.applyUpdate(room, update, DRAFT_AGENT_BROADCAST_ORIGIN);
}

export function createHocuspocusBinding(eventSink?: EventSink) {
  let instance: Hocuspocus | null = null;
  return {
    bind(hocuspocus: Hocuspocus): void {
      instance = hocuspocus;
    },
    current(): Hocuspocus | null {
      return instance;
    },
    require(): Hocuspocus {
      if (!instance) throw new Error("Hocuspocus is not bound to the collab domain");
      return instance;
    },
    closeDraft(draftId: string, olderThan?: number): void {
      closeDraftRooms(instance, draftId, olderThan);
    },
    applyToRoom,
    deliverDraftUpdate({ draftId, update }: { draftId: string; update: Uint8Array }): void {
      try {
        const prefix = `draft:${draftId}:gen:`;
        for (const [roomName, draftDoc] of instance?.documents.entries() ?? []) {
          if (roomName.startsWith(prefix)) {
            applyToRoom(draftDoc, update);
          }
        }
      } catch (cause) {
        if (!eventSink) return;
        emitEvent(eventSink, {
          level: "warn",
          source: "collab.draft_review",
          name: "draft_update_broadcast.failed",
          payload: { draftId, ...unknownToEventPayload(cause) },
        });
      }
    },
  };
}
