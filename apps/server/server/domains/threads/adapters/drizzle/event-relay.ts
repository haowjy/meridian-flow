/** Relays committed PostgreSQL journal notifications into this process's live hub. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import type { EventSink } from "../../../observability/index.js";
import { emitEvent, unknownToEventPayload } from "../../../observability/index.js";
import type { ThreadEventHub } from "../../thread-event-hub.js";

export async function listenForThreadEvents(input: {
  db: Database;
  eventHub: Pick<ThreadEventHub, "invalidateCommittedJournal">;
  eventSink: EventSink;
}): Promise<{ unlisten: () => Promise<void> }> {
  return input.db.listen("thread_events", (payload) => {
    void relay(payload).catch((cause) => {
      emitEvent(input.eventSink, {
        level: "error",
        source: "threads.event-relay",
        name: "notification.failed",
        payload: { notification: payload, ...unknownToEventPayload(cause) },
      });
    });
  });

  async function relay(payload: string): Promise<void> {
    const separator = payload.lastIndexOf(":");
    if (separator < 1) throw new Error("Malformed thread event notification");
    const threadId = payload.slice(0, separator) as ThreadId;
    // The sequence only wakes this process. The hub drains all committed rows
    // after its cursor, so reversed and duplicated notifications are harmless.
    const notifiedSeq = BigInt(payload.slice(separator + 1));
    if (notifiedSeq < 1n) throw new Error("Malformed thread event notification sequence");
    input.eventHub.invalidateCommittedJournal(threadId);
  }
}
