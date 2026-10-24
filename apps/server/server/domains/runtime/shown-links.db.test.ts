/**
 * E-1: shown-link evidence on PostgreSQL threads (contract §7.3).
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - current shown links persistence protocol (kb/decisions/engineering/runtime/runtime-delivery-and-run-claim.md)
 */

import type { ProjectId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import type { Thread, Turn } from "@meridian/contracts/threads";
import type { SpelledLinkFact } from "@meridian/markup/links";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { ShownLinkStore } from "./ports/shown-links.js";
import {
  type ShownLinksCheck,
  shownLink,
  shownLinkStoreChecks,
} from "./shown-links.test-support.js";

const url = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

if (!RUN_DB_TESTS || !url) {
  describe.skip("shown links (postgres)", () => {});
} else {
  describe("shown links (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests, conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { deleteDrizzleRows } = await import("../../test-support/drizzle-reset.js");
    const { createCompactionFixture } = await import("./loop/__tests__/compaction-db-fixture.js");
    const { createDrizzleShownLinkStore } = await import("./adapters/drizzle/shown-links.js");
    const { createDrizzleRepositoriesForTest } = await import(
      "../threads/adapters/drizzle/repositories.js"
    );
    assertThrowawayDatabaseForRunDbTests(url);
    const db = createDb(url, { max: 8 });
    afterAll(() => db.close());
    const compactionFixture = createCompactionFixture(db);

    /** A PostgreSQL project with one document. */
    async function seedDocument(projectId: string) {
      const sourceId = crypto.randomUUID();
      const documentId = crypto.randomUUID();
      await db.insert(schema.contextSources).values({
        id: sourceId,
        projectId,
        name: "Knowledge",
        slug: "kb",
        scope: "project",
      });
      await db.insert(schema.documents).values({
        id: documentId,
        contextSourceId: sourceId,
        name: "chapter",
        extension: "",
        fileType: "markdown",
      });
      return documentId;
    }

    /** A thread with an answer turn and a spawned child, on `adapter`'s repositories. */
    async function storeScene() {
      const userId = crypto.randomUUID() as UserId;
      const projectId = crypto.randomUUID() as ProjectId;
      await db.insert(schema.users).values(conformanceUserValues(userId, "shown-links"));
      await db
        .insert(schema.projects)
        .values({ id: projectId, userId, name: "Shown", slug: "shown" });
      const repos = createDrizzleRepositoriesForTest(db);
      const documentId = await seedDocument(projectId);
      const thread = await repos.threads.create({ aiWriteMode: "direct", userId, projectId });
      const answer = await repos.turns.create({
        threadId: thread.id as ThreadId,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      const child = await repos.threads.createSubagent({
        aiWriteMode: "direct",
        userId,
        projectId,
        parentThreadId: thread.id as ThreadId,
        rootThreadId: thread.id as ThreadId,
        originTurnId: answer.id as TurnId,
        spawnDepth: 1,
      });
      return { repos, threadId: thread.id, childId: child.id, documentId, compaction: undefined };
    }

    /** The real runtime composition, only for the row that compacts. */
    async function compactionScene() {
      const compaction = await compactionFixture();
      return {
        repos: compaction.repos,
        threadId: compaction.threadId,
        childId: compaction.ids.child,
        documentId: await seedDocument(compaction.ids.project),
        compaction,
      };
    }

    async function rig(scene: "store" | "compaction") {
      const { repos, threadId, childId, documentId, compaction } =
        scene === "compaction" ? await compactionScene() : await storeScene();
      const store: ShownLinkStore = createDrizzleShownLinkStore(db);
      const transaction = <T>(operation: () => Promise<T>) => repos.transaction(operation);
      const turns = await repos.turns.listByThread(threadId as ThreadId);
      const answer = turns.at(-1) as Turn;
      const source = (await repos.threads.findById(threadId as ThreadId)) as Thread;
      const show = (threadId: string, turn: Turn, links: SpelledLinkFact[]) =>
        store.record({
          threadId,
          turnId: turn.id,
          documentId,
          holderUri: "kb://chapter.md",
          view: { kind: "live" },
          links,
        });
      const seen = async (threadId: string) =>
        (await store.forDocument(threadId, documentId))
          .map((row) => `${row.ref.slice(4, 12)}@${row.address}`)
          .sort();
      const derive = async (originType: "fork" | "handoff", origin: Turn, from = source) =>
        (
          await repos.threads.createDerivedPrimary({
            aiWriteMode: "direct",
            id: crypto.randomUUID(),
            source: from,
            workId: from.workId,
            userId: from.userId,
            projectId: from.projectId,
            originType,
            originTurnId: origin.id as TurnId,
          })
        ).thread;
      const next = (thread: Thread, prev: Turn) =>
        repos.turns.create({
          threadId: thread.id as ThreadId,
          prevTurnId: prev.id as TurnId,
          role: "user",
          origin: "writer",
          status: "complete",
        });
      return {
        compaction,
        childId,
        store,
        answer,
        source,
        show,
        seen,
        derive,
        next,
        documentId,
        transaction,
      };
    }
    type Rig = Awaited<ReturnType<typeof rig>>;
    type Check = ShownLinksCheck;

    /**
     * Holds `turnId`'s next insert of `address` after it drew its sequence
     * value and before conflict arbitration, as a suspended backend would,
     * while `meanwhile` records the same key with a larger value.
     */
    async function invertSequence(
      r: Rig,
      input: { turnId: string; fact: SpelledLinkFact; meanwhile: () => Promise<void> },
    ) {
      const lockKey = 7_291_730;
      const fn = `e1_delay_${crypto.randomUUID().replaceAll("-", "")}`;
      // Only the next value drawn waits, so the competing writer passes.
      const [{ last }] = (await db.execute(
        sql.raw(`SELECT last_value AS last FROM thread_shown_links_seq_seq`),
      )) as unknown as Array<{ last: string }>;
      await db.execute(
        sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.address = '${input.fact.address}' AND NEW.seq = ${Number(last) + 1}
          THEN PERFORM pg_advisory_xact_lock(${lockKey}); END IF; RETURN NEW; END $$`),
      );
      await db.execute(
        sql.raw(
          `CREATE TRIGGER ${fn} BEFORE INSERT ON thread_shown_links FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
        ),
      );
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held!: (pid: number) => void;
      const holding = new Promise<number>((resolve) => {
        held = resolve;
      });
      const holder = db.transaction(async (tx) => {
        const [{ pid }] = (await tx.execute(
          sql.raw(`SELECT pg_backend_pid() AS pid, pg_advisory_xact_lock(${lockKey})`),
        )) as unknown as Array<{ pid: number }>;
        held(pid);
        await released;
      });
      let delayed: Promise<void> | undefined;
      try {
        const holderPid = await holding;
        delayed = r.show(r.source.id, { id: input.turnId } as Turn, [input.fact]);
        // The delayed insert is the backend this holder blocks on this key, not any advisory waiter.
        const deadline = Date.now() + 5_000;
        for (;;) {
          const waiting = await db.execute(
            sql.raw(`SELECT 1 FROM pg_locks l
              WHERE l.locktype = 'advisory' AND NOT l.granted
                AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                AND l.classid = 0 AND l.objid = ${lockKey} AND l.objsubid = 1
                AND ${holderPid} = ANY(pg_blocking_pids(l.pid))`),
          );
          if (waiting.length > 0) break;
          if (Date.now() > deadline) throw new Error("the delayed insert never waited on the lock");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await input.meanwhile();
        release();
        await holder;
        await delayed;
      } finally {
        release();
        await Promise.allSettled([holder, delayed]);
        await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON thread_shown_links`));
        await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
      }
    }

    const rows: Array<{
      name: string;
      scene?: "compaction";
      run(r: Rig, check: Check): Promise<void>;
    }> = [
      ...shownLinkStoreChecks,
      {
        name: "rows survive a real compaction",
        scene: "compaction",
        async run({ compaction, answer, source, show, seen }, check) {
          if (!compaction) throw new Error("the compaction scene builds the runtime");
          await show(source.id, answer, [shownLink(1), shownLink(2)]);
          const run = await compaction.orchestrator.prepare({
            threadId: compaction.threadId,
            tools: [],
            userText: "Continue.",
          });
          await run.execute();
          const turn = await compaction.repos.turns.findById(run.executionTurnId);
          check(turn?.role, "the run compacted").toBe("compaction");
          check(await seen(source.id), "rows after compaction").toEqual([
            "00000001@kb://target-1.md",
            "00000002@kb://target-2.md",
          ]);
        },
      },
      {
        name: "a delayed lower sequence never overwrites a greater one",
        async run(r, check) {
          const fact = shownLink(6, "kb://race.md");
          await r.show(r.source.id, r.answer, [fact]);
          let winner = -1;
          await invertSequence(r, {
            turnId: r.answer.id,
            fact,
            async meanwhile() {
              await r.show(r.source.id, r.answer, [fact]);
              winner = (await r.store.forDocument(r.source.id, r.documentId))[0]?.at ?? -1;
            },
          });
          const rows = await r.store.forDocument(r.source.id, r.documentId);
          check(
            rows.map((row) => row.at),
            "the greater sequence stays",
          ).toEqual([winner]);
        },
      },
    ];

    it("E-1: evidence keeps its showings across dedup, compaction, lineage and races", async () => {
      for (const row of rows) {
        const check: Check = (actual, what) => expect.soft(actual, `${row.name}: ${what}`);
        try {
          await deleteDrizzleRows(db, [schema.users]);
          await row.run(await rig(row.scene ?? "store"), check);
        } catch (error) {
          check(error, "row threw").toBeUndefined();
        }
      }
    }, 120_000);
  });
}
