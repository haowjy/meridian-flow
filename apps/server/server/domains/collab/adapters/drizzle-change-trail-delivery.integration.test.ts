/** Real-Postgres crash-window proofs for durable change-trail event delivery. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("change-trail delivery crash windows (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("change-trail delivery crash windows (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createNoopEventSink } = await import("../../observability/index.js");
    const { createDrizzleEventJournalReader, createDrizzleEventJournalWriter } = await import(
      "../../threads/adapters/drizzle/index.js"
    );
    const { createThreadEventHub } = await import("../../threads/thread-event-hub.js");
    const { truncateDrizzleTables } = await import("../../../test-support/drizzle-reset.js");
    const { createChangeTrailDeliveryDispatcher } = await import(
      "./drizzle-change-trail-delivery.js"
    );

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 6 });
    const journalWriter = createDrizzleEventJournalWriter(db);
    const journalReader = createDrizzleEventJournalReader(db);

    const USER_ID = "00000000-0000-4000-8000-000000000a01";
    const PROJECT_ID = "00000000-0000-4000-8000-000000000a02";
    const THREAD_ID = "00000000-0000-4000-8000-000000000a03" as ThreadId;
    const TURN_ID = "00000000-0000-4000-8000-000000000a04" as TurnId;
    const TRAIL_ID = "00000000-0000-4000-8000-000000000a05";
    const UPDATED_EVENT_ID = "00000000-0000-4000-8000-000000000a06";
    const SETTLED_EVENT_ID = "00000000-0000-4000-8000-000000000a07";

    beforeEach(async () => {
      await truncateDrizzleTables(db, [
        schema.eventJournal,
        schema.changeTrailDeliveryOutbox,
        schema.changeTrailShells,
        schema.turns,
        schema.threads,
        schema.projects,
        schema.users,
      ]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "trail-delivery-crash"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Trail delivery crash proofs",
        slug: "trail-delivery-crash-proofs",
      });
      await db.insert(schema.threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Crash proof thread",
        kind: "primary",
        status: "active",
      });
      await db.insert(schema.turns).values({
        id: TURN_ID,
        threadId: THREAD_ID,
        role: "assistant",
        status: "complete",
      });
      await db.insert(schema.changeTrailShells).values({
        id: TRAIL_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        ownerKind: "turn",
        state: "settled",
        version: 1,
        changeCount: 2,
        sweptChangeCount: 0,
        documentCount: 1,
        settledAt: new Date(),
      });
    });

    afterAll(async () => {
      await db.$client.end();
    });

    it("retries exactly once after a crash between claim and journal append", async () => {
      await seedOutbox([{ eventId: UPDATED_EVENT_ID, eventKind: "updated", version: 1 }]);
      const crashingWriter = {
        appendEvent: vi.fn(async () => {
          throw new Error("injected crash before journal append");
        }),
      };
      const firstDispatcher = createChangeTrailDeliveryDispatcher({
        db,
        journalWriter: crashingWriter,
        eventHub: { publishPersistedEvent: vi.fn() },
      });

      await expect(firstDispatcher.dispatchOne()).rejects.toThrow(
        "injected crash before journal append",
      );
      expect(crashingWriter.appendEvent).toHaveBeenCalledOnce();
      await expect(outboxDelivery(UPDATED_EVENT_ID)).resolves.toBeNull();
      await expect(journalEvents(UPDATED_EVENT_ID)).resolves.toEqual([]);

      const publishPersistedEvent = vi.fn();
      const retryDispatcher = createChangeTrailDeliveryDispatcher({
        db,
        journalWriter,
        eventHub: { publishPersistedEvent },
      });
      await expect(retryDispatcher.dispatchOne()).resolves.toBe(true);

      await expect(outboxDelivery(UPDATED_EVENT_ID)).resolves.toBeInstanceOf(Date);
      const events = await journalEvents(UPDATED_EVENT_ID);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ eventId: UPDATED_EVENT_ID, version: 1 });
      expect(publishPersistedEvent).toHaveBeenCalledOnce();
    });

    it("replays a committed event after a crash before process-local publish", async () => {
      await seedOutbox([{ eventId: UPDATED_EVENT_ID, eventKind: "updated", version: 1 }]);
      const crashingHub = {
        publishPersistedEvent: vi.fn(() => {
          throw new Error("injected crash before process-local publish");
        }),
      };
      const dispatcher = createChangeTrailDeliveryDispatcher({
        db,
        journalWriter,
        eventHub: crashingHub,
      });

      await expect(dispatcher.dispatchOne()).rejects.toThrow(
        "injected crash before process-local publish",
      );
      await expect(outboxDelivery(UPDATED_EVENT_ID)).resolves.toBeInstanceOf(Date);
      await expect(journalEvents(UPDATED_EVENT_ID)).resolves.toHaveLength(1);

      const reconnectHub = createThreadEventHub({
        journalWriter,
        journalReader,
        eventSink: createNoopEventSink(),
      });
      const liveSubscriber = vi.fn();
      const subscription = await reconnectHub.catchupAndSubscribe(THREAD_ID, 0n, liveSubscriber);
      expect(subscription.catchup).toHaveLength(1);
      expect(subscription.catchup[0]?.event).toMatchObject({
        type: "CUSTOM",
        name: "meridian.turn_change_trail.updated",
        value: expect.objectContaining({ eventId: UPDATED_EVENT_ID, version: 1 }),
      });
      expect(liveSubscriber).not.toHaveBeenCalled();
      subscription.unsubscribe();
      await expect(journalEvents(UPDATED_EVENT_ID)).resolves.toHaveLength(1);
    });

    it("keeps updated before settled while two dispatchers drain one trail", async () => {
      await seedOutbox([
        { eventId: UPDATED_EVENT_ID, eventKind: "updated", version: 1 },
        { eventId: SETTLED_EVENT_ID, eventKind: "settled", version: 2 },
      ]);
      let releaseFirstAppend!: () => void;
      const firstAppendBlocked = new Promise<void>((resolve) => {
        releaseFirstAppend = resolve;
      });
      let firstAppendClaimed!: () => void;
      const firstAppendReached = new Promise<void>((resolve) => {
        firstAppendClaimed = resolve;
      });
      const blockingWriter = {
        async appendEvent(
          threadId: ThreadId,
          event: Parameters<typeof journalWriter.appendEvent>[1],
        ) {
          firstAppendClaimed();
          await firstAppendBlocked;
          return journalWriter.appendEvent(threadId, event);
        },
      };
      const published: Array<{ eventId: string; version: number }> = [];
      const eventHub = {
        publishPersistedEvent: (_threadId: ThreadId, _seq: bigint, event: OrchestratorEvent) => {
          if (
            event.type !== "turn.change_trail_updated" &&
            event.type !== "turn.change_trail_settled"
          ) {
            throw new Error(`Unexpected event type: ${event.type}`);
          }
          published.push({ eventId: event.eventId, version: event.version });
        },
      };
      const firstDispatcher = createChangeTrailDeliveryDispatcher({
        db,
        journalWriter: blockingWriter,
        eventHub,
      });
      const secondDispatcher = createChangeTrailDeliveryDispatcher({ db, journalWriter, eventHub });

      const firstDispatch = firstDispatcher.dispatchOne();
      await firstAppendReached;
      await expect(secondDispatcher.dispatchOne()).resolves.toBe(false);
      await expect(journalEvents(SETTLED_EVENT_ID)).resolves.toEqual([]);

      releaseFirstAppend();
      await expect(firstDispatch).resolves.toBe(true);
      await expect(secondDispatcher.drain()).resolves.toBe(1);

      const rows = await db
        .select({ seq: schema.eventJournal.seq, payload: schema.eventJournal.payload })
        .from(schema.eventJournal)
        .where(eq(schema.eventJournal.threadId, THREAD_ID))
        .orderBy(schema.eventJournal.seq);
      expect(rows.map((row) => row.payload)).toMatchObject([
        { eventId: UPDATED_EVENT_ID, type: "turn.change_trail_updated", version: 1 },
        { eventId: SETTLED_EVENT_ID, type: "turn.change_trail_settled", version: 2 },
      ]);
      expect(rows.map((row) => row.seq)).toEqual([1n, 2n]);
      expect(published).toEqual([
        { eventId: UPDATED_EVENT_ID, version: 1 },
        { eventId: SETTLED_EVENT_ID, version: 2 },
      ]);
    });

    async function seedOutbox(
      events: Array<{ eventId: string; eventKind: "updated" | "settled"; version: number }>,
    ): Promise<void> {
      await db.insert(schema.changeTrailDeliveryOutbox).values(
        events.map((event, index) => ({
          ...event,
          threadId: THREAD_ID,
          trailId: TRAIL_ID,
          changeCount: event.eventKind === "updated" ? 2 : null,
          sweptChangeCount: event.eventKind === "updated" ? 0 : null,
          documentCount: event.eventKind === "updated" ? 1 : null,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
        })),
      );
    }

    async function outboxDelivery(eventId: string): Promise<Date | null> {
      const [row] = await db
        .select({ deliveredAt: schema.changeTrailDeliveryOutbox.deliveredAt })
        .from(schema.changeTrailDeliveryOutbox)
        .where(eq(schema.changeTrailDeliveryOutbox.eventId, eventId));
      return row?.deliveredAt ?? null;
    }

    async function journalEvents(eventId: string) {
      return db
        .select({ seq: schema.eventJournal.seq, payload: schema.eventJournal.payload })
        .from(schema.eventJournal)
        .where(sql`${schema.eventJournal.payload}->>'eventId' = ${eventId}`);
    }
  });
}
