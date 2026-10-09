/**
 * E-1: shown-link evidence on PostgreSQL threads (contract §7.3), for both
 * store adapters. Dedup keeps the latest showing per key; rows survive a real
 * compaction; a fork reads its source's showings only up to its cutoff turn,
 * and a source's later repeat never takes one away; a handoff and a spawned
 * child inherit nothing; a showing recorded in a failed persistence rolls
 * back with it; a writer delayed after drawing its sequence never rewinds a
 * key's order.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Thread, Turn } from "@meridian/contracts/threads";
import type { SpelledLinkFact } from "@meridian/markup/links";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { ShownLinkStore } from "./ports/shown-links.js";

const url = process.env.DATABASE_URL;
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

const link = (n: number, address = `kb://target-${n}.md`): SpelledLinkFact => ({
  ref: `doc:0000000${n}-0000-4000-8000-000000000000`,
  address,
});

if (!RUN_DB_TESTS || !url) {
  describe.skip("shown links (postgres)", () => {});
} else {
  describe("shown links (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { assertThrowawayDatabaseForRunDbTests } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { deleteDrizzleRows } = await import("../../test-support/drizzle-reset.js");
    const { createCompactionFixture } = await import("./loop/__tests__/compaction-db-fixture.js");
    const { createDrizzleShownLinkStore } = await import("./adapters/drizzle/shown-links.js");
    const { createInMemoryShownLinkStore } = await import("./adapters/in-memory/shown-links.js");
    const { InMemoryTransactionOwner } = await import("../../shared/in-memory-transaction.js");
    assertThrowawayDatabaseForRunDbTests(url);
    const db = createDb(url, { max: 8 });
    afterAll(() => db.close());
    const fixture = createCompactionFixture(db);

    async function rig(adapter: "drizzle" | "in-memory") {
      const rig = await fixture();
      const sourceId = crypto.randomUUID();
      const documentId = crypto.randomUUID();
      await db.insert(schema.contextSources).values({
        id: sourceId,
        projectId: rig.ids.project,
        name: "Knowledge",
        slug: "kb",
        scope: "project",
      });
      await db.insert(schema.documents).values({
        id: documentId,
        contextSourceId: sourceId,
        name: "chapter",
        extension: "md",
        fileType: "markdown",
      });
      const owner = new InMemoryTransactionOwner();
      const store: ShownLinkStore =
        adapter === "drizzle"
          ? createDrizzleShownLinkStore(db)
          : createInMemoryShownLinkStore({
              transactionOwner: owner,
              threads: rig.repos.threads,
              turns: rig.repos.turns,
            });
      // The transaction the adapter's repositories commit through.
      const transaction = <T>(operation: () => Promise<T>) =>
        adapter === "drizzle" ? rig.repos.transaction(operation) : owner.run(operation);
      const turns = await rig.repos.turns.listByThread(rig.threadId);
      const answer = turns.at(-1) as Turn;
      const source = (await rig.repos.threads.findById(rig.threadId)) as Thread;
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
          await rig.repos.threads.createDerivedPrimary({
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
        rig.repos.turns.create({
          threadId: thread.id as ThreadId,
          prevTurnId: prev.id as TurnId,
          role: "user",
          origin: "writer",
          status: "complete",
        });
      return { rig, store, answer, source, show, seen, derive, next, documentId, transaction };
    }
    type Rig = Awaited<ReturnType<typeof rig>>;
    type Adapter = "drizzle" | "in-memory";
    type Check = (actual: unknown, what: string) => ReturnType<typeof expect.soft>;

    /** Refs in showing order, latest last: the order correspondence ranks them. */
    const ordered = async ({ store, documentId }: Rig, threadId: string) =>
      (await store.forDocument(threadId, documentId)).map((row) => row.ref);

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
      adapters?: readonly Adapter[];
      run(r: Rig, check: Check): Promise<void>;
    }> = [
      {
        name: "dedup keeps the latest showing per key",
        async run({ store, answer, source, show, next, documentId }, check) {
          await show(source.id, answer, [link(1), link(1)]);
          await show(source.id, answer, [link(1, "kb://moved.md")]);
          const later = await next(source, answer);
          await show(source.id, later, [link(1)]);
          const rows = await store.forDocument(source.id, documentId);
          check(
            rows.map((row) => [row.address, row.view]),
            "one row per key, latest last",
          ).toEqual([
            ["kb://moved.md", "live"],
            ["kb://target-1.md", "live"],
          ]);
        },
      },
      {
        name: "rows survive a real compaction",
        async run({ rig, answer, source, show, seen }, check) {
          await show(source.id, answer, [link(1), link(2)]);
          const run = await rig.orchestrator.prepare({
            threadId: rig.threadId,
            tools: [],
            userText: "Continue.",
          });
          await run.execute();
          const compaction = await rig.repos.turns.findById(run.executionTurnId);
          check(compaction?.role, "the run compacted").toBe("compaction");
          check(await seen(source.id), "rows after compaction").toEqual([
            "00000001@kb://target-1.md",
            "00000002@kb://target-2.md",
          ]);
        },
      },
      {
        name: "a fork sees source showings up to its cutoff; handoffs and children inherit none",
        async run({ rig, answer, source, show, seen, derive, next }, check) {
          await show(source.id, answer, [link(1)]);
          const later = await next(source, answer);
          await show(source.id, later, [link(2)]);
          const fork = await derive("fork", answer);
          const forkTurn = await next(fork, answer);
          await show(fork.id, forkTurn, [link(3)]);
          const nested = await derive("fork", forkTurn, fork);
          const handoff = await derive("handoff", later);
          check(await seen(source.id), "source").toEqual([
            "00000001@kb://target-1.md",
            "00000002@kb://target-2.md",
          ]);
          check(await seen(fork.id), "fork").toEqual([
            "00000001@kb://target-1.md",
            "00000003@kb://target-3.md",
          ]);
          check(await seen(nested.id), "nested fork").toEqual([
            "00000001@kb://target-1.md",
            "00000003@kb://target-3.md",
          ]);
          check(await seen(handoff.id), "handoff").toEqual([]);
          check(await seen(rig.ids.child), "spawned child").toEqual([]);
        },
      },
      {
        name: "a source's repeat after the cutoff keeps the fork's showing against a competing ref",
        async run(r, check) {
          const { answer, source, show, derive, next } = r;
          // Two refs at one address: correspondence binds to whichever was shown last.
          const competing = link(4, "kb://same.md");
          const shownLast = link(5, "kb://same.md");
          await show(source.id, answer, [competing, shownLast]);
          const fork = await derive("fork", answer);
          const nested = await derive("fork", await next(fork, answer), fork);
          await show(source.id, await next(source, answer), [shownLast]);
          for (const [threadId, what] of [
            [source.id, "source"],
            [fork.id, "fork"],
            [nested.id, "nested fork"],
          ] as const) {
            check(await ordered(r, threadId), what).toEqual([competing.ref, shownLast.ref]);
          }
        },
      },
      {
        name: "a showing recorded in a failed persistence rolls back with it",
        async run({ answer, source, show, seen, transaction }, check) {
          await show(source.id, answer, [link(7)]);
          const failed = await transaction(async () => {
            await show(source.id, answer, [link(8)]);
            throw new Error("result persistence failed");
          }).catch((error: Error) => error.message);
          check(failed, "the persistence failed").toBe("result persistence failed");
          check(await seen(source.id), "only the committed showing").toEqual([
            "00000007@kb://target-7.md",
          ]);
        },
      },
      {
        name: "an address past the index tuple limit records exactly and dedups per turn",
        async run({ store, answer, source, show, documentId }, check) {
          // Incompressible, so the stored key cannot shrink below PostgreSQL's B-tree limit.
          let seed = 730;
          const segment = () =>
            Array.from({ length: 90 }, () => {
              seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
              return "abcdefghijklmnopqrstuvwxyz0123456789"[seed % 36];
            }).join("");
          const long = link(9, `kb://${Array.from({ length: 36 }, segment).join("/")}.md`);
          await show(source.id, answer, [long]);
          await show(source.id, answer, [long]);
          check(
            (await store.forDocument(source.id, documentId)).map((row) => row.address),
            "one exact row",
          ).toEqual([long.address]);
        },
      },
      {
        name: "a delayed lower sequence never overwrites a greater one",
        adapters: ["drizzle"],
        async run(r, check) {
          const fact = link(6, "kb://race.md");
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
        for (const adapter of row.adapters ?? (["drizzle", "in-memory"] as const)) {
          const check: Check = (actual, what) =>
            expect.soft(actual, `${row.name} (${adapter}): ${what}`);
          try {
            await deleteDrizzleRows(db, [schema.users]);
            await row.run(await rig(adapter), check);
          } catch (error) {
            check(error, "row threw").toBeUndefined();
          }
        }
      }
    }, 120_000);
  });
}
