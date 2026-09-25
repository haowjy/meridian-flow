/** Relays committed PostgreSQL journal notifications into this process's live hub. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import type { EventSink } from "../../../observability/index.js";
import { emitEvent, unknownToEventPayload } from "../../../observability/index.js";
import type { EventJournalReader } from "../../ports/index.js";
import type { ThreadEventHub } from "../../thread-event-hub.js";

const RELISTEN_REPLAY_BATCH_SIZE = 500;

export async function listenForThreadEvents(input: {
  db: Database;
  journalReader: EventJournalReader;
  eventHub: Pick<ThreadEventHub, "publishPersistedEvent" | "activeThreadJournalHeads">;
  eventSink: EventSink;
}): Promise<{ unlisten: () => Promise<void> }> {
  let hasConnectedOnce = false;
  let catchUpInFlight = false;
  let catchUpAgain = false;
  return input.db.listen(
    "thread_events",
    (payload) => {
      void relay(payload).catch((cause) => {
        emitEvent(input.eventSink, {
          level: "error",
          source: "threads.event-relay",
          name: "notification.failed",
          payload: { notification: payload, ...unknownToEventPayload(cause) },
        });
      });
    },
    () => {
      if (!hasConnectedOnce) {
        hasConnectedOnce = true;
        return;
      }
      requestCatchUp();
    },
  );

  async function catchUpActiveSubscribers(): Promise<void> {
    for (const { threadId, afterSeq: initialSeq } of input.eventHub.activeThreadJournalHeads()) {
      let afterSeq = initialSeq;
      while (true) {
        const entries = await input.journalReader.readAfter(
          threadId,
          afterSeq,
          RELISTEN_REPLAY_BATCH_SIZE,
        );
        for (const entry of entries) {
          input.eventHub.publishPersistedEvent(threadId, entry.seq, entry.payload);
          afterSeq = entry.seq;
        }
        if (entries.length < RELISTEN_REPLAY_BATCH_SIZE) break;
      }
    }
  }

  function requestCatchUp(): void {
    catchUpAgain = true;
    if (catchUpInFlight) return;
    catchUpInFlight = true;
    void (async () => {
      try {
        while (catchUpAgain) {
          catchUpAgain = false;
          await catchUpActiveSubscribers();
        }
      } catch (cause) {
        emitEvent(input.eventSink, {
          level: "error",
          source: "threads.event-relay",
          name: "relisten_catchup.failed",
          payload: unknownToEventPayload(cause),
        });
      } finally {
        catchUpInFlight = false;
        if (catchUpAgain) requestCatchUp();
      }
    })();
  }

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
