/** Relays committed PostgreSQL journal notifications into this process's live hub. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import type { EventSink } from "../../../observability/index.js";
import { emitEvent, unknownToEventPayload } from "../../../observability/index.js";
import type { EventJournalReader } from "../../ports/index.js";
import type { ThreadEventHub } from "../../thread-event-hub.js";

export async function listenForThreadEvents(input: {
  db: Database;
  journalReader: EventJournalReader;
  eventHub: Pick<ThreadEventHub, "publishPersistedEvent">;
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
    const seq = BigInt(payload.slice(separator + 1));
    const [entry] = await input.journalReader.readAfter(threadId, seq - 1n, 1);
    if (!entry || entry.seq !== seq) throw new Error("Notified journal event is unavailable");
    input.eventHub.publishPersistedEvent(threadId, seq, entry.payload);
  }
}
