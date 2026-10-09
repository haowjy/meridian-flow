/**
 * E-1: shown-link evidence on PostgreSQL threads (contract §7.3), for both
 * store adapters. Dedup keeps the latest showing per key; rows survive a real
 * compaction; a fork reads its source's showings only up to its cutoff turn,
 * while a handoff and a spawned child inherit nothing.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Thread, Turn } from "@meridian/contracts/threads";
import type { SpelledLinkFact } from "@meridian/markup";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
    assertThrowawayDatabaseForRunDbTests(url);
    const db = createDb(url, { max: 8 });
    beforeEach(() => deleteDrizzleRows(db, [schema.users]));
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
      const store: ShownLinkStore =
        adapter === "drizzle"
          ? createDrizzleShownLinkStore(db)
          : createInMemoryShownLinkStore({ threads: rig.repos.threads, turns: rig.repos.turns });
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
      return { rig, store, answer, source, show, seen, derive, next, documentId };
    }
    type Rig = Awaited<ReturnType<typeof rig>>;

    const cases: Array<{ name: string; run: (r: Rig) => Promise<void> }> = [
      {
        name: "dedup keeps the latest showing per key",
        async run({ store, answer, source, show, next, documentId }) {
          await show(source.id, answer, [link(1), link(1)]);
          await show(source.id, answer, [link(1, "kb://moved.md")]);
          const later = await next(source, answer);
          await show(source.id, later, [link(1)]);
          const rows = await store.forDocument(source.id, documentId);
          expect(rows).toHaveLength(2);
          const original = rows.find((row) => row.address === "kb://target-1.md");
          const moved = rows.find((row) => row.address === "kb://moved.md");
          expect(original?.at).toBeGreaterThan(moved?.at ?? Number.POSITIVE_INFINITY);
          expect(rows.at(-1)).toMatchObject({ address: "kb://target-1.md", view: "live" });
        },
      },
      {
        name: "rows survive a real compaction",
        async run({ rig, answer, source, show, seen }) {
          await show(source.id, answer, [link(1), link(2)]);
          const run = await rig.orchestrator.prepare({
            threadId: rig.threadId,
            tools: [],
            userText: "Continue.",
          });
          await run.execute();
          const compaction = await rig.repos.turns.findById(run.executionTurnId);
          expect(compaction?.role).toBe("compaction");
          expect(await seen(source.id)).toEqual([
            "00000001@kb://target-1.md",
            "00000002@kb://target-2.md",
          ]);
        },
      },
      {
        name: "a fork sees source showings up to its cutoff; handoffs and children inherit none",
        async run({ rig, answer, source, show, seen, derive, next }) {
          await show(source.id, answer, [link(1)]);
          const later = await next(source, answer);
          await show(source.id, later, [link(2)]);
          const fork = await derive("fork", answer);
          const forkTurn = await next(fork, answer);
          await show(fork.id, forkTurn, [link(3)]);
          const nested = await derive("fork", forkTurn, fork);
          const handoff = await derive("handoff", later);
          const child = rig.ids.child;
          expect(await seen(source.id)).toEqual([
            "00000001@kb://target-1.md",
            "00000002@kb://target-2.md",
          ]);
          expect(await seen(fork.id)).toEqual([
            "00000001@kb://target-1.md",
            "00000003@kb://target-3.md",
          ]);
          expect(await seen(nested.id)).toEqual([
            "00000001@kb://target-1.md",
            "00000003@kb://target-3.md",
          ]);
          expect(await seen(handoff.id)).toEqual([]);
          expect(await seen(child)).toEqual([]);
        },
      },
    ];

    it.each(
      cases.flatMap((entry) =>
        (["drizzle", "in-memory"] as const).map((adapter) => ({ ...entry, adapter })),
      ),
    )("$name ($adapter)", async ({ run, adapter }) => {
      await run(await rig(adapter));
    });
  });
}
