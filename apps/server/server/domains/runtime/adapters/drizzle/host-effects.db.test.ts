/**
 * PostgreSQL coverage for the runtime's host-effects outbox.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a row is deleted only when its handler returns, and each row is delivered on its own
 * - a process delivers one row at a time, in one coalesced loop, so delivery holds at most two connections
 * - a failed row is next due after HOST_EFFECT_BACKOFF_MS, and the loop takes only due rows
 * - two processes share the table through FOR UPDATE SKIP LOCKED: the second skips a locked row
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-0000000009b1";
const PROJECT_ID = "00000000-0000-4000-8000-0000000009b2";
const THREAD = "00000000-0000-4000-8000-0000000009b3" as ThreadId;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("host effects (postgres)", () => {});
} else {
  describe("host effects (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { eq, sql } = await import("drizzle-orm");
    const { deleteDrizzleRows } = await import("../../../../test-support/drizzle-reset.js");
    const { createDetachedWorkTracker } = await import("../../../../shared/detached-work.js");
    const { currentDrizzleDb, runInDrizzleTransaction } = await import(
      "../../../../shared/drizzle-transaction.js"
    );
    const { createNoopEventSink } = await import("../../../observability/index.js");
    const { createHostEffectOutbox, HOST_EFFECT_STUCK_ATTEMPTS } = await import(
      "./host-effects.js"
    );

    assertThrowawayDatabaseForRunDbTests(DATABASE_URL);
    const db = createDb(DATABASE_URL, { max: 8 });
    // Two connections: one a delivery's lock, one its handler's transaction.
    const smallDb = createDb(DATABASE_URL, { max: 2 });

    const outboxFor = (
      handle: (effect: { id: string; kind: string }) => Promise<void>,
      options: { pool?: typeof db; events?: string[] } = {},
    ) => {
      const backgroundTasks = createDetachedWorkTracker();
      const outbox = createHostEffectOutbox({
        db: options.pool ?? db,
        host: { handle: (effect) => handle(effect) },
        eventSink: options.events
          ? { ...createNoopEventSink(), emit: (event) => void options.events?.push(event.name) }
          : createNoopEventSink(),
        backgroundTasks,
      });
      return { outbox, backgroundTasks };
    };
    const makeDue = () => db.update(schema.hostEffects).set({ nextAttemptAt: sql`now()` });
    const rows = () => db.select().from(schema.hostEffects).orderBy(schema.hostEffects.id);
    const projectName = async () =>
      (await db.select().from(schema.projects).where(eq(schema.projects.id, PROJECT_ID)))[0]?.name;

    beforeEach(async () => {
      await deleteDrizzleRows(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "host-effects"));
      await db.insert(schema.projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "before",
        slug: "host-effects",
      });
      await db.insert(schema.threads).values({
        rootThreadId: THREAD,
        id: THREAD,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Thread",
      });
    });
    afterAll(async () => {
      await smallDb.close();
      await db.close();
    });

    it("delivers after the recording transaction commits, and not when it rolls back", async () => {
      const handled: string[] = [];
      const { outbox, backgroundTasks } = outboxFor(async (effect) => {
        handled.push(effect.kind);
      });
      await expect(
        runInDrizzleTransaction(db, async () => {
          await outbox.record(THREAD, "rolled.back", {});
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      await backgroundTasks.drain();
      expect(handled).toEqual([]);
      expect(await rows()).toHaveLength(0);

      await runInDrizzleTransaction(db, () => outbox.record(THREAD, "committed", {}));
      await backgroundTasks.drain();
      expect(handled).toEqual(["committed"]);
      expect(await rows()).toHaveLength(0);
    });

    it("delivers at boot a row whose process died after the commit", async () => {
      await db.insert(schema.hostEffects).values({ threadId: THREAD, kind: "orphan", payload: {} });
      const handled: string[] = [];
      const { outbox } = outboxFor(async (effect) => {
        handled.push(effect.kind);
      });
      expect(await outbox.deliver()).toBe(1);
      expect(handled).toEqual(["orphan"]);
      expect(await rows()).toHaveLength(0);
    });

    it("leaves nothing done when the handler throws after its update, and the retry does it all", async () => {
      await db.insert(schema.hostEffects).values({ threadId: THREAD, kind: "update", payload: {} });
      let failing = true;
      const { outbox } = outboxFor(() =>
        runInDrizzleTransaction(db, async () => {
          await currentDrizzleDb(db)
            .update(schema.projects)
            .set({ name: "after" })
            .where(eq(schema.projects.id, PROJECT_ID));
          if (failing) throw new Error("refresh failed");
        }),
      );
      expect(await outbox.deliver()).toBe(0);
      expect(await projectName()).toBe("before");
      expect((await rows()).map((row) => row.attempts)).toEqual([1]);

      failing = false;
      await makeDue();
      expect(await outbox.deliver()).toBe(1);
      expect(await projectName()).toBe("after");
      expect(await rows()).toHaveLength(0);
    });

    it("delivers ten effects recorded at once on a pool of two", async () => {
      const handled: string[] = [];
      const { outbox, backgroundTasks } = outboxFor(
        (effect) =>
          runInDrizzleTransaction(smallDb, async () => {
            handled.push(effect.kind);
          }),
        { pool: smallDb },
      );
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          runInDrizzleTransaction(smallDb, () => outbox.record(THREAD, `k${i}`, {})),
        ),
      );
      await backgroundTasks.drain();
      expect(handled).toHaveLength(10);
      expect(await rows()).toHaveLength(0);
    });

    it("runs one delivery loop: a wake while it runs makes it go round once more", async () => {
      await db.insert(schema.hostEffects).values({ threadId: THREAD, kind: "first", payload: {} });
      let active = 0;
      let overlap = 0;
      const handled: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { outbox } = outboxFor(async (effect) => {
        active += 1;
        overlap = Math.max(overlap, active);
        if (effect.kind === "first") await gate;
        handled.push(effect.kind);
        active -= 1;
      });
      const running = outbox.deliver();
      await db.insert(schema.hostEffects).values({ threadId: THREAD, kind: "second", payload: {} });
      const woken = outbox.deliver();
      release();
      expect(await Promise.all([running, woken])).toEqual([2, 2]);
      expect(handled).toEqual(["first", "second"]);
      expect(overlap).toBe(1);
    });

    it("tries a failing row once per backoff, holds back no other, and logs it stuck once", async () => {
      await db.insert(schema.hostEffects).values([
        { threadId: THREAD, kind: "stuck", payload: {} },
        { threadId: THREAD, kind: "fine", payload: {} },
      ]);
      let tries = 0;
      const events: string[] = [];
      const { outbox } = outboxFor(
        async (effect) => {
          if (effect.kind !== "stuck") return;
          tries += 1;
          throw new Error("always");
        },
        { events },
      );
      await outbox.deliver();
      await outbox.deliver();
      await outbox.deliver();
      expect(tries).toBe(1);
      const [failed] = await rows();
      expect(failed?.kind).toBe("stuck");
      expect(failed?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

      for (let attempt = 2; attempt <= HOST_EFFECT_STUCK_ATTEMPTS + 2; attempt += 1) {
        await makeDue();
        await outbox.deliver();
        expect((await rows()).map((row) => row.attempts)).toEqual([attempt]);
      }
      expect(events.filter((name) => name === "effect.stuck")).toHaveLength(1);
    });

    it("stops taking rows once the scheduler's signal aborts", async () => {
      await db.insert(schema.hostEffects).values([
        { threadId: THREAD, kind: "a", payload: {} },
        { threadId: THREAD, kind: "b", payload: {} },
      ]);
      const abort = new AbortController();
      const handled: string[] = [];
      const { outbox } = outboxFor(async (effect) => {
        handled.push(effect.kind);
        abort.abort();
      });
      expect(await outbox.deliver(abort.signal)).toBe(1);
      expect(handled).toEqual(["a"]);
      expect(await rows()).toHaveLength(1);
    });

    it("lets a second process skip a row the first has locked", async () => {
      await db.insert(schema.hostEffects).values([
        { threadId: THREAD, kind: "k1", payload: {} },
        { threadId: THREAD, kind: "k2", payload: {} },
      ]);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const handled: string[] = [];
      const a = outboxFor(async (effect) => {
        started();
        await gate;
        handled.push(effect.kind);
      }).outbox;
      const b = outboxFor(async (effect) => {
        handled.push(effect.kind);
      }).outbox;
      const fromA = a.deliver();
      await firstStarted;
      // A holds k1's lock and is blocked; B must deliver k2 without waiting for it.
      expect(await b.deliver()).toBe(1);
      release();
      expect(await fromA).toBe(1);
      expect([...handled].sort()).toEqual(["k1", "k2"]);
      expect(await rows()).toHaveLength(0);
    });
  });
}
