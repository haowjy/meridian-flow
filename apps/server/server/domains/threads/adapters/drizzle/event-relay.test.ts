/** Cross-process thread event relay contract. */
import { describe, expect, it, vi } from "vitest";
import { createNoopEventSink } from "../../../observability/index.js";
import { listenForThreadEvents } from "./event-relay.js";

describe("listenForThreadEvents", () => {
  it("publishes a journal event notified by another process into the local hub", async () => {
    let notify: ((payload: string) => void) | undefined;
    const publishPersistedEvent = vi.fn();
    const event = {
      type: "turn.change_trail_settled" as const,
      eventId: "00000000-0000-4000-8000-000000000901",
      threadId: "00000000-0000-4000-8000-000000000902",
      trailId: "00000000-0000-4000-8000-000000000903",
      turnId: "00000000-0000-4000-8000-000000000904",
      version: 2,
    };
    await listenForThreadEvents({
      db: {
        listen: vi.fn(async (_channel: string, callback: (payload: string) => void) => {
          notify = callback;
          return { unlisten: vi.fn(async () => {}) };
        }),
      } as never,
      journalReader: {
        readAfter: vi.fn(async () => [{ seq: 7n, payload: event }]),
      } as never,
      eventHub: { publishPersistedEvent },
      eventSink: createNoopEventSink(),
    });

    notify?.(`${event.threadId}:7`);
    await vi.waitFor(() =>
      expect(publishPersistedEvent).toHaveBeenCalledWith(event.threadId, 7n, event),
    );
  });
});
