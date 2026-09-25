import type { Database } from "@meridian/database";
import { describe, expect, it, vi } from "vitest";
import type { EventSink } from "../../../observability/index.js";
import type { EventJournalReader } from "../../ports/index.js";
import type { ThreadEventHub } from "../../thread-event-hub.js";
import { createThreadEventHub } from "../../thread-event-hub.js";
import { listenForThreadEvents } from "./event-relay.js";

describe("thread event relay", () => {
  it("seeds an empty thread at zero after re-LISTEN without a racy head lookup", async () => {
    let onListen: (() => void) | undefined;
    let activeReads = 0;
    let maxActiveReads = 0;
    const threadId = "thread-idle" as never;
    const readAfter = vi.fn(async (_threadId: unknown, _afterSeq: bigint) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeReads -= 1;
      return [];
    });
    const journalReader = {
      readAfter,
      headSeq: vi.fn(async () => 900n),
    } as unknown as EventJournalReader;
    const eventSink = { emit() {}, emitBatch() {}, async flush() {} } as EventSink;
    const hub = createThreadEventHub(
      {
        journalReader,
        journalWriter: { appendEvent: async () => 0n },
        eventSink,
      },
      { evictionGraceMs: 60_000 },
    );
    const subscription = await hub.catchupAndSubscribe(threadId, 0n, () => {});
    expect(journalReader.headSeq).not.toHaveBeenCalled();
    readAfter.mockClear();
    const db = {
      listen: async (_channel: string, _notify: unknown, onlisten?: () => void) => {
        onListen = onlisten;
        onlisten?.();
        return { unlisten: async () => {} };
      },
    } as unknown as Database;

    await listenForThreadEvents({ db, journalReader, eventHub: hub, eventSink });
    onListen?.();
    onListen?.();
    await vi.waitFor(() => expect(readAfter).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(readAfter).toHaveBeenCalledWith(threadId, 0n, expect.anything());
    expect(journalReader.headSeq).not.toHaveBeenCalled();
    expect(maxActiveReads).toBe(1);
    subscription.unsubscribe();
  });

  it("replays journal events for live subscribers after postgres re-LISTENs", async () => {
    let onListen: (() => void) | undefined;
    const activeThreadId = "thread-live" as never;
    const inactiveThreadId = "thread-inactive" as never;
    const entries = [
      { seq: 2n, payload: { type: "replay-2" } },
      { seq: 3n, payload: { type: "replay-3" } },
    ];
    const readAfter = vi.fn(async (threadId: unknown, afterSeq: bigint, limit?: number) => {
      if (threadId !== activeThreadId) return [];
      return entries.filter((entry) => entry.seq > afterSeq).slice(0, limit);
    });
    const publishPersistedEvent = vi.fn();
    const db = {
      listen: async (_channel: string, _notify: unknown, onlisten?: () => void) => {
        onListen = onlisten;
        onlisten?.();
        return { unlisten: async () => {} };
      },
    } as unknown as Database;
    const eventHub = {
      activeThreadJournalHeads: () => [{ threadId: activeThreadId, afterSeq: 1n }],
      publishPersistedEvent,
    } as unknown as Pick<ThreadEventHub, "publishPersistedEvent" | "activeThreadJournalHeads">;

    await listenForThreadEvents({
      db,
      journalReader: { readAfter } as unknown as EventJournalReader,
      eventHub,
      eventSink: {} as EventSink,
    });

    expect(readAfter).not.toHaveBeenCalled();
    onListen?.();
    await vi.waitFor(() => expect(publishPersistedEvent).toHaveBeenCalledTimes(2));
    expect(publishPersistedEvent).toHaveBeenNthCalledWith(
      1,
      activeThreadId,
      2n,
      entries[0].payload,
    );
    expect(publishPersistedEvent).toHaveBeenNthCalledWith(
      2,
      activeThreadId,
      3n,
      entries[1].payload,
    );
    expect(readAfter).toHaveBeenCalledOnce();
    expect(readAfter).not.toHaveBeenCalledWith(
      inactiveThreadId,
      expect.anything(),
      expect.anything(),
    );
  });
});
