/** Mutable Hocuspocus instance binding and branch-room publication adapter. */
import type { Hocuspocus, TransactionOrigin } from "@hocuspocus/server";
import * as Y from "yjs";
import type { EventSink } from "../../observability/index.js";
import { emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { closeBranchRooms } from "../hocuspocus-rooms.js";

const BRANCH_AGENT_BROADCAST_ORIGIN = {
  source: "local",
  context: { origin: { type: "system", reason: "branch-agent-append" } },
} satisfies TransactionOrigin;

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
    closeBranch(branchId: string): void {
      closeBranchRooms(instance, branchId);
    },
    publishBranchUpdate({ branchId, update }: { branchId: string; update: Uint8Array }): void {
      try {
        const prefix = `branch:${branchId}:gen:`;
        for (const [roomName, branchDoc] of instance?.documents.entries() ?? []) {
          if (roomName.startsWith(prefix)) {
            Y.applyUpdate(branchDoc, update, BRANCH_AGENT_BROADCAST_ORIGIN);
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
