/**
 * PostgreSQL coverage for the runtime's host-effects outbox.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a row is deleted only when its handler returns, and each row is delivered on its own
 * - two processes share the table through FOR UPDATE SKIP LOCKED
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
    const { eq } = await import("drizzle-orm");
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

    const outboxFor = (handle: (effect: { id: string; kind: string }) => Promise<void>) => {
      const backgroundTasks = createDetachedWorkTracker();
      const outbox = createHostEffectOutbox({
        db,
        host: { handle: (effect) => handle(effect) },
        eventSink: createNoopEventSink(),
        backgroundTasks,
      });
      return { outbox, backgroundTasks };
    };
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
    afterAll(() => db.close());

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
      expect(await outbox.deliver()).toBe(1);
      expect(await projectName()).toBe("after");
      expect(await rows()).toHaveLength(0);
    });

    it("lets a failing row hold back no other, and counts its attempts", async () => {
      await db.insert(schema.hostEffects).values([
        { threadId: THREAD, kind: "stuck", payload: {} },
        { threadId: THREAD, kind: "fine", payload: {} },
      ]);
      const { outbox } = outboxFor(async (effect) => {
        if (effect.kind === "stuck") throw new Error("always");
      });
      for (let pass = 1; pass <= HOST_EFFECT_STUCK_ATTEMPTS; pass += 1) {
        await outbox.deliver();
        expect((await rows()).map((row) => [row.kind, row.attempts])).toEqual([["stuck", pass]]);
      }
    });

    it("delivers each row once when two processes deliver together", async () => {
      await db
        .insert(schema.hostEffects)
        .values(
          Array.from({ length: 12 }, (_, i) => ({ threadId: THREAD, kind: `k${i}`, payload: {} })),
        );
      const handled: string[] = [];
      const slow = async (effect: { kind: string }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        handled.push(effect.kind);
      };
      const a = outboxFor(slow).outbox;
      const b = outboxFor(slow).outbox;
      const [fromA, fromB] = await Promise.all([a.deliver(), b.deliver()]);
      expect(fromA + fromB).toBe(12);
      expect([...handled].sort()).toEqual(Array.from({ length: 12 }, (_, i) => `k${i}`).sort());
      expect(await rows()).toHaveLength(0);
    });
  });
}
