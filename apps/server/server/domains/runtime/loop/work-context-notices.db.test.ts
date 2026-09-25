/** Business mutations, durable Work notice history, and request-boundary replay against Postgres. */
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestWorkProjectionMutation } from "../../../test-support/work-projection.js";
import { createDrizzleProjectWorkRepository, updateWork } from "../../projects/index.js";
import { createDrizzleRepositoriesForTest } from "../../threads/adapters/drizzle/repositories.js";
import { rebindThreadWork } from "../../threads/domain/rebind-thread-work.js";
import { createDrizzleEventJournalWriter } from "../../threads/index.js";
import {
  THREAD_WORK_RACE as ids,
  resetThreadWorkRaceFixture,
} from "../../threads/test-support/thread-work-postgres-harness.js";
import { createDrizzleRunClaim } from "../adapters/drizzle-run-claim.js";
import { createTestDrizzleDelivery } from "./__tests__/test-drizzle-delivery.js";
import { createLocalTurn } from "./local-turn.js";
import { persistAndAppendTurnStartEvents } from "./persistence.js";
import { createWorkContextReader } from "./work-context.js";
import { persistWriterEnqueue } from "./writer-enqueue.js";

const url = process.env.RUN_DB_TESTS === "1" ? process.env.DATABASE_URL : undefined;
if (!url) describe.skip("Work inbox notices (postgres)", () => {});
else
  describe("Work inbox notices (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const db = createDb(url, { max: 6 });
    const repos = createDrizzleRepositoriesForTest(db);
    const works = createDrizzleProjectWorkRepository({
      db,
      hasUnreviewedDraft: async () => false,
      projectionMutation: createTestWorkProjectionMutation(db),
    });
    const workContext = createWorkContextReader({
      threads: repos.threads,
      threadWorks: repos.threadWorks,
      works,
    });
    const eventWriter = createDrizzleEventJournalWriter(db);
    const runClaim = createDrizzleRunClaim(db);
    const delivery = () =>
      createTestDrizzleDelivery(db, { repos, workContext, eventWriter, runClaim });
    const updates = async () =>
      (await repos.turns.listByThread(ids.threadId)).filter(
        (turn) => (turn.metadata as { kind?: string })?.kind === "system_update",
      );
    const rebind = (workId: string, notices = delivery()) =>
      repos.transaction(() =>
        rebindThreadWork(
          {
            threads: repos.threads,
            threadWorks: repos.threadWorks,
            works,
            workContextNotices: notices,
          },
          { threadId: ids.threadId, workId },
        ),
      );
    beforeEach(async () => {
      await resetThreadWorkRaceFixture(db);
      await db
        .update(schema.works)
        .set({ status: "active", archivedAt: null })
        .where(eq(schema.works.id, ids.targetWorkId));
      await repos.threadWorks.addMembership(ids.threadId, ids.workId, true);
      await db
        .update(schema.threads)
        .set({ composedSystemPrompt: "frozen prompt", bakedSkillSlugs: [] })
        .where(eq(schema.threads.id, ids.threadId));
    });
    afterAll(() => db.close());

    it("rolls Work mutation, binding, and inserted notices back with their business transaction", async () => {
      const before = await works.findById(ids.workId);
      await expect(
        repos.transaction(async () => {
          await updateWork({ works, workContextNotices: delivery() }, ids.workId, {
            goal: "lost goal",
          });
          expect(await delivery().selectPending(ids.threadId)).toHaveLength(1);
          throw new Error("business failure");
        }),
      ).rejects.toThrow("business failure");
      expect((await works.findById(ids.workId))?.goal).toBe(before?.goal);
      await expect(
        repos.transaction(async () => {
          await rebind(ids.targetWorkId);
          expect(await delivery().selectPending(ids.threadId)).toHaveLength(1);
          throw new Error("business failure");
        }),
      ).rejects.toThrow("business failure");
      expect(await repos.threadWorks.findPrimary(ids.threadId)).toEqual({ workId: ids.workId });
      expect(await delivery().selectPending(ids.threadId)).toEqual([]);
    });

    it("coalesces immutable mutation rows into latest-state history without waking or rebaking", async () => {
      const notices = delivery();
      await updateWork({ works, workContextNotices: notices }, ids.workId, { goal: "first" });
      await updateWork({ works, workContextNotices: notices }, ids.workId, { goal: "latest" });
      await rebind(ids.targetWorkId);
      const pending = await notices.selectPending(ids.threadId);
      expect(pending).toHaveLength(3);
      expect(new Set(pending.map((row) => row.idempotencyKey)).size).toBe(3);
      expect(
        pending.every(
          (row) =>
            row.intent === "notice" &&
            row.provenance.kind === "system" &&
            row.body.kind === "work_context_refresh",
        ),
      ).toBe(true);
      expect(await notices.pendingMessageThreads(100)).toEqual([]);
      await expect(notices.materializeIdle(ids.threadId)).resolves.toBe("delivered");
      expect(await updates()).toHaveLength(1);
      const [update] = await updates();
      if (!update) throw new Error("Missing update");
      const blocks = await repos.blocks.listByTurn(update.id);
      expect(blocks[0]?.textContent).toContain("latest");
      expect(blocks[0]?.textContent).toContain("<system_update>");
      expect(await notices.selectPending(ids.threadId)).toEqual([]);
      expect((await repos.threads.findById(ids.threadId))?.composedSystemPrompt).toBe(
        "frozen prompt",
      );
      await notices.sweepWorkNotices();
      expect(await updates()).toHaveLength(1);
    });

    it("replays after a turn/event failure with exactly one committed update and ack", async () => {
      await delivery().threadChanged(ids.threadId);
      const failed = createTestDrizzleDelivery(db, {
        repos,
        workContext,
        runClaim,
        eventWriter: {
          async appendEvent(threadId, event) {
            if (event.type === "work_context.changed") throw new Error("crash before ack");
            return eventWriter.appendEvent(threadId, event);
          },
        },
      });
      await expect(failed.materializeIdle(ids.threadId)).rejects.toThrow("crash before ack");
      expect(await updates()).toHaveLength(0);
      expect(await delivery().selectPending(ids.threadId)).toHaveLength(1);
      await delivery().sweepWorkNotices();
      expect(await updates()).toHaveLength(1);
      expect(await delivery().selectPending(ids.threadId)).toEqual([]);
      const events = await db
        .select()
        .from(schema.eventJournal)
        .where(eq(schema.eventJournal.threadId, ids.threadId));
      expect(events.filter((row) => row.eventType === "work_context.changed")).toHaveLength(1);
    });

    it.each([
      "deleted",
      "archived",
      "project-deleted",
    ])("parks %s targets, including new mutations, until restore", async (hidden) => {
      if (hidden === "project-deleted")
        await db
          .update(schema.projects)
          .set({ deletedAt: new Date() })
          .where(eq(schema.projects.id, ids.projectId));
      else
        await db
          .update(schema.threads)
          .set(hidden === "deleted" ? { deletedAt: new Date() } : { status: "archived" })
          .where(eq(schema.threads.id, ids.threadId));
      await delivery().projectChanged(ids.projectId);
      await delivery().sweepWorkNotices();
      expect(await updates()).toHaveLength(0);
      expect(await delivery().selectPending(ids.threadId)).toHaveLength(1);
      await db
        .update(schema.projects)
        .set({ deletedAt: null })
        .where(eq(schema.projects.id, ids.projectId));
      await db
        .update(schema.threads)
        .set({ deletedAt: null, status: "idle" })
        .where(eq(schema.threads.id, ids.threadId));
      await delivery().sweepWorkNotices();
      expect(await updates()).toHaveLength(1);
    });

    it("materializes at a held run boundary, ordered with messages, and excludes Work IDs from response ack", async () => {
      const notices = delivery();
      const lease = await runClaim.startExecution(ids.threadId, crypto.randomUUID());
      if (!lease) throw new Error("Missing lease");
      const assistant = createLocalTurn({
        threadId: ids.threadId,
        prevTurnId: null,
        role: "assistant",
        status: "streaming",
      });
      try {
        await notices.adoptBatch(lease, async () => {
          await persistAndAppendTurnStartEvents(
            { repos, eventWriter },
            ids.threadId,
            null,
            async () => ({ result: null, events: [{ type: "turn.created", turn: assistant }] }),
          );
          return { value: null, turnId: assistant.id, messageIds: [] };
        });
        await rebind(ids.targetWorkId, notices);
        await expect(notices.materializeIdle(ids.threadId)).resolves.toBe("pending");
        const message = await notices.enqueue({
          threadId: ids.threadId,
          intent: "message",
          provenance: { kind: "agent", threadId: ids.threadId },
          body: { kind: "text", text: "Continue" },
          idempotencyKey: "directed",
        });
        const boundary = await notices.splitAndContinue({
          lease,
          currentTurn: assistant,
          knownTurnIds: new Set([assistant.id]),
          expectedLeafTurnId: assistant.id,
        });
        expect(boundary.split).toBe(true);
        expect(
          boundary.drain.turns.map((turn) => (turn.metadata as { kind: string }).kind),
        ).toEqual(["system_update", "message"]);
        expect(boundary.drain.turns[0]?.prevTurnId).toBe(assistant.id);
        expect(boundary.drain.turns[1]?.prevTurnId).toBe(boundary.drain.turns[0]?.id);
        expect(boundary.next.prevTurnId).toBe(message.id);
        expect(boundary.drain.ackIds).toEqual([message.id]);
        expect((await notices.selectPending(ids.threadId)).map((row) => row.id)).toEqual([
          message.id,
        ]);
        expect((await repos.threads.findById(ids.threadId))?.composedSystemPrompt).toBe(
          "frozen prompt",
        );
        await notices.threadChanged(ids.threadId);
        const noticeOnly = await notices.splitAndContinue({
          lease,
          currentTurn: boundary.next,
          knownTurnIds: new Set([
            assistant.id,
            ...boundary.drain.turns.map((turn) => turn.id),
            boundary.next.id,
          ]),
          expectedLeafTurnId: boundary.next.id,
        });
        expect(noticeOnly.split).toBe(true);
        expect(noticeOnly.drain.turns[0]?.prevTurnId).toBe(boundary.next.id);
        expect(noticeOnly.next.prevTurnId).toBe(noticeOnly.drain.turns[0]?.id);
        expect(await runClaim.readRunningTurnId(ids.threadId)).toBe(noticeOnly.next.id);
        expect(await updates()).toHaveLength(2);
      } finally {
        await runClaim.release(lease);
      }
    });

    it.each([
      "work-first",
      "writer-first",
    ])("preserves %s inbox order in writer and idle materialization", async (order) => {
      const notices = delivery();
      const writerId = crypto.randomUUID();
      const send = () =>
        persistWriterEnqueue({
          persistence: { repos, eventWriter },
          hub: {
            async headSeq() {
              return 0n;
            },
          },
          threadId: ids.threadId,
          userTurnId: writerId,
          userBlocks: [{ type: "text", text: "Writer follows queue order" }],
          delivery: notices,
          inbox: notices,
          draft: {
            id: writerId,
            threadId: ids.threadId,
            intent: "message",
            provenance: { kind: "writer", actorId: ids.userId },
            body: { kind: "text", text: "Writer follows queue order" },
            idempotencyKey: writerId,
          },
          settle: async () => true,
        });
      if (order === "work-first") {
        await notices.threadChanged(ids.threadId);
        await send();
      } else {
        await send();
        await notices.threadChanged(ids.threadId);
      }
      await notices.materializeIdle(ids.threadId);
      const [work] = await updates();
      if (!work) throw new Error("Missing Work update");
      const writer = await repos.turns.findById(writerId);
      expect(order === "work-first" ? writer?.prevTurnId : work.prevTurnId).toBe(
        order === "work-first" ? work.id : writerId,
      );
      const rows = await db
        .select()
        .from(schema.threadInboxMessages)
        .where(eq(schema.threadInboxMessages.threadId, ids.threadId))
        .orderBy(schema.threadInboxMessages.seq);
      expect(rows.map((row) => row.id)).toEqual(
        order === "work-first" ? [work.id, writerId] : [writerId, work.id],
      );
      expect((await notices.selectPending(ids.threadId)).map((row) => row.id)).toEqual([writerId]);
    });

    it.each([
      false,
      true,
    ])("adopts the durable Work prefix in chain order (earlier writer: %s)", async (earlierWriter) => {
      const notices = delivery();
      const lease = await runClaim.startExecution(ids.threadId, crypto.randomUUID());
      if (!lease) throw new Error("Missing lease");
      const assistant = createLocalTurn({
        threadId: ids.threadId,
        prevTurnId: null,
        role: "assistant",
        status: "streaming",
      });
      try {
        await notices.adoptBatch(lease, async () => {
          await persistAndAppendTurnStartEvents(
            { repos, eventWriter },
            ids.threadId,
            null,
            async () => ({ result: null, events: [{ type: "turn.created", turn: assistant }] }),
          );
          return { value: null, turnId: assistant.id, messageIds: [] };
        });
        const send = (writerId: string) =>
          persistWriterEnqueue({
            persistence: { repos, eventWriter },
            hub: {
              async headSeq() {
                return 0n;
              },
            },
            threadId: ids.threadId,
            userTurnId: writerId,
            userBlocks: [{ type: "text", text: "Continue" }],
            delivery: notices,
            inbox: notices,
            draft: {
              id: writerId,
              threadId: ids.threadId,
              intent: "message",
              provenance: { kind: "writer", actorId: ids.userId },
              body: { kind: "text", text: "Continue" },
              idempotencyKey: writerId,
            },
            settle: async () => true,
          });
        const firstWriterId = crypto.randomUUID();
        if (earlierWriter) await send(firstWriterId);
        await notices.threadChanged(ids.threadId);
        const writerId = crypto.randomUUID();
        await send(writerId);
        const boundary = await notices.splitAndContinue({
          lease,
          currentTurn: assistant,
          knownTurnIds: new Set([assistant.id]),
          expectedLeafTurnId: assistant.id,
        });
        expect(boundary.split).toBe(true);
        const [work] = await updates();
        expect(boundary.drain.turns.map((turn) => turn.id)).toEqual([
          ...(earlierWriter ? [firstWriterId] : []),
          work?.id,
          writerId,
        ]);
        expect(work?.prevTurnId).toBe(earlierWriter ? firstWriterId : assistant.id);
        expect(boundary.drain.turns.at(-1)?.prevTurnId).toBe(work?.id);
        expect(
          boundary.drain.blocks.find((block) => block.turnId === work?.id)?.textContent,
        ).toContain("system_update");
        expect(boundary.next.prevTurnId).toBe(writerId);
        expect(await updates()).toHaveLength(1);
      } finally {
        await runClaim.release(lease);
      }
    });

    it("commits a Work mutation racing a materializer holding the thread visibility lock", async () => {
      const notices = delivery();
      await notices.threadChanged(ids.threadId);
      let held!: () => void;
      let render!: () => void;
      const workHeld = new Promise<void>((resolve) => {
        held = resolve;
      });
      const rendering = new Promise<void>((resolve) => {
        render = resolve;
      });
      const mutation = updateWork(
        {
          works,
          workContextNotices: {
            async projectChanged(projectId) {
              held();
              await rendering;
              await notices.projectChanged(projectId);
            },
          },
        },
        ids.workId,
        { goal: "racing goal" },
      );
      await workHeld;
      const slow = createTestDrizzleDelivery(db, {
        repos,
        runClaim,
        eventWriter,
        workContext: {
          async renderForThread(id) {
            render();
            return workContext.renderForThread(id);
          },
        },
      });
      const results = await Promise.allSettled([mutation, slow.materializeIdle(ids.threadId)]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await notices.selectPending(ids.threadId)).toHaveLength(1);
      expect(await updates()).toHaveLength(1);
    });

    it("keeps a racing mutation pending", async () => {
      const notices = delivery();
      await notices.threadChanged(ids.threadId);
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow = createTestDrizzleDelivery(db, {
        repos,
        runClaim,
        workContext: {
          async renderForThread(id) {
            entered();
            await gate;
            return workContext.renderForThread(id);
          },
        },
      });
      const materializing = slow.materializeIdle(ids.threadId);
      await ready;
      const mutation = notices.threadChanged(ids.threadId);
      release();
      await Promise.all([materializing, mutation]);
      expect(await notices.selectPending(ids.threadId)).toHaveLength(1);
      expect(await updates()).toHaveLength(1);
    });
    it("cascades pending inbox markers when their thread is hard-deleted", async () => {
      await db.insert(schema.threadInboxMessages).values({
        threadId: ids.threadId,
        intent: "notice",
        provenance: { kind: "system", source: "work_context" },
        body: { kind: "work_context_refresh" },
        idempotencyKey: "hard-delete",
      });
      await db.delete(schema.threads).where(eq(schema.threads.id, ids.threadId));
      expect(await delivery().selectPending(ids.threadId)).toEqual([]);
    });
  });
