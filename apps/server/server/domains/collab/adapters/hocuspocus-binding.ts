/** Mutable Hocuspocus instance binding and branch-room delivery: publication and repair. */
import type { Hocuspocus, TransactionOrigin } from "@hocuspocus/server";
import * as Y from "yjs";
import type { EventSink } from "../../observability/index.js";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { closeBranchRooms } from "../hocuspocus-rooms.js";

const BRANCH_AGENT_BROADCAST_ORIGIN = {
  source: "local",
  context: { origin: { type: "system", reason: "branch-agent-append" } },
} satisfies TransactionOrigin;

/** Content a branch room did not author: Hocuspocus broadcasts it to the room's tabs. */
function applyToRoom(room: Y.Doc, update: Uint8Array): void {
  Y.applyUpdate(room, update, BRANCH_AGENT_BROADCAST_ORIGIN);
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
    closeBranch(branchId: string, olderThan?: number): void {
      closeBranchRooms(instance, branchId, olderThan);
    },
    applyToRoom,
    publishBranchUpdate({ branchId, update }: { branchId: string; update: Uint8Array }): void {
      try {
        const prefix = `branch:${branchId}:gen:`;
        for (const [roomName, branchDoc] of instance?.documents.entries() ?? []) {
          if (roomName.startsWith(prefix)) {
            applyToRoom(branchDoc, update);
          }
        }
      } catch (cause) {
        if (!eventSink) return;
        emitEvent(eventSink, {
          level: "warn",
          source: "collab.branch_review",
          name: "branch_update_broadcast.failed",
          payload: { branchId, ...unknownToEventPayload(cause) },
        });
      }
    },
  };
}
