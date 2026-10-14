/** PostgreSQL proof for ahead registration, the namespace race with arrival, and settlement CAS. */
import { createDb, type Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  linkAheadRefs,
  projects,
  threads,
  users,
  works,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { RegistrationInsideTransactionError } from "../ports/link-ahead-registry.js";
import {
  contextNamespaceKey,
  lockContextSources,
  lockNamespaceKeys,
} from "./context-fs/document-locations.js";
import { awaitedStripeKey, createDrizzleLinkAheadRegistry } from "./drizzle-link-ahead-registry.js";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN =
  (process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true") && DATABASE_URL;

if (!RUN) {
  describe.skip("ahead-ref registry (postgres)", () => {});
} else {
  describe("ahead-ref registry (postgres)", () => {
    const USER = "00000000-0000-4000-8000-000000000b01";
    const PROJECT = "00000000-0000-4000-8000-000000000b02";
    const SOURCE = "00000000-0000-4000-8000-000000000b03";
    const DOCUMENT = "00000000-0000-4000-8000-000000000b04";
    const AHEAD = "00000000-0000-4000-8000-000000000b05";
    const NO_WORK = "00000000-0000-4000-8000-000000000b08";
    const DOCUMENT_2 = "00000000-0000-4000-8000-000000000b0a";
    const OTHER_PROJECT = "00000000-0000-4000-8000-000000000b0c";
    const OTHER_SOURCE = "00000000-0000-4000-8000-000000000b0d";
    const SOURCES = {
      manuscript: SOURCE,
      scratch: "00000000-0000-4000-8000-000000000b0b",
    } as const;
    type Scheme = keyof typeof SOURCES;
    const addressFor = (scheme: Scheme) =>
      scheme === "manuscript" ? "manuscript://chapter.toml" : `${scheme}://@notes/chapter.toml`;
    const registrationFor = (scheme: Scheme, aheadId = AHEAD) => ({
      aheadId,
      holderProjectId: PROJECT as never,
      address: addressFor(scheme),
    });
    const registration = registrationFor("manuscript");
    // Controlled manifest membership: tests decide which SQL rows are live.
    let liveMembers: string[] = [];
    const membership = async () => ({ members: liveMembers });
    // Registration commits in its own root transaction, so no rollback fixture: reset by FK order.
    const database = createDb(DATABASE_URL, { max: 4 });
    const arrivalConnection = createDb(DATABASE_URL, { max: 2 });
    const gateConnection = createDb(DATABASE_URL, { max: 2 });

    async function seed() {
      liveMembers = [DOCUMENT, DOCUMENT_2];
      await deleteDrizzleRows(database, [users]);
      await database.insert(users).values(conformanceUserValues(USER, "ahead-registry"));
      await database
        .insert(projects)
        .values({ id: PROJECT, userId: USER, name: "Ahead Project", slug: "ahead-project" });
      await database.insert(works).values({
        id: NO_WORK,
        projectId: PROJECT,
        createdByUserId: USER,
        name: "Notes",
        slug: "notes",
        isNoWork: false,
      });
      await database
        .insert(contextSources)
        .values({ id: SOURCE, projectId: PROJECT, name: "Manuscript", slug: "manuscript" });
      for (const scheme of ["scratch"] as const) {
        await database.insert(contextSources).values({
          id: SOURCES[scheme],
          workId: NO_WORK,
          scope: "work",
          name: scheme,
          slug: scheme,
        });
      }
    }
    const insertDocument = (db: Database, scheme: Scheme = "manuscript", id = DOCUMENT) =>
      db
        .insert(documents)
        .values({ id, contextSourceId: SOURCES[scheme], name: "chapter", extension: "toml" });
    const settledIds = async () =>
      (await database.select({ id: linkAheadRefs.settledDocumentId }).from(linkAheadRefs)).map(
        (row) => row.id,
      );
    const newRegistry = (db: Database) => createDrizzleLinkAheadRegistry(db, membership);

    /** The exact key real arrivals take for this scheme's source (Work: the persisted row id). */
    const arrivalKey = (scheme: Scheme) =>
      contextNamespaceKey({
        projectId: PROJECT,
        userId: USER,
        scheme,
        workId: scheme === "manuscript" ? null : NO_WORK,
      });

    /** Number of sessions blocked on exactly this namespace key in this database. */
    async function waitersOn(key: string) {
      const rows = await database.execute<{ waiting: number }>(sql`
        SELECT count(*)::int AS waiting FROM pg_locks l
        WHERE l.locktype = 'advisory' AND NOT l.granted
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended(${key}, 0::bigint)`);
      return rows[0]?.waiting ?? 0;
    }
    // Every schedule wait is bounded well under the test timeout so cleanup always runs.
    const WAIT_MS = 3_000;
    async function waitForWaiters(key: string, count: number) {
      for (let attempt = 0; attempt < WAIT_MS / 20; attempt++) {
        if ((await waitersOn(key)) >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`expected ${count} session(s) queued behind ${key}`);
    }

    /**
     * A one-shot signal from inside a producer's transaction. It fails as soon as its producer
     * settles without signalling, or after WAIT_MS, so a failed producer rejects its owner.
     */
    function notification(label: string) {
      let notify!: () => void;
      let fail!: (error: unknown) => void;
      const fired = new Promise<void>((resolve, reject) => {
        notify = resolve;
        fail = reject;
      });
      fired.catch(() => undefined); // an owner that already failed never waits
      return {
        notify: () => notify(),
        /** Attach the producer at once so its failure is owned here, never left unhandled. */
        from<T>(producer: Promise<T>) {
          producer.then(() => fail(new Error(`${label}: producer finished without it`)), fail);
          return producer;
        },
        async wait() {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${label}: not seen in ${WAIT_MS}ms`)),
              WAIT_MS,
            );
          });
          try {
            await Promise.race([fired, deadline]);
          } finally {
            clearTimeout(timer);
          }
        },
      };
    }

    /** Real arrival: source lock, insert, settle, in the arrival connection's transaction. */
    const arrive = (scheme: Scheme, id = DOCUMENT, before?: () => Promise<void>) =>
      runInDrizzleTransaction(arrivalConnection, async () => {
        await lockContextSources(arrivalConnection, [SOURCES[scheme]]);
        await insertDocument(arrivalConnection, scheme, id);
        await before?.();
        return newRegistry(arrivalConnection).settleArrivals([id as never]);
      });

    beforeEach(seed);
    afterAll(async () => {
      await deleteDrizzleRows(database, [users]);
      await gateConnection.close();
      await arrivalConnection.close();
      await database.close();
    });

    /** Arrival holds its key; registration queues on the same key and sees the document. */
    async function raceArrivalFirst(scheme: Scheme) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lockTaken = notification("arrival lock");
      const arrival = lockTaken.from(
        arrive(scheme, DOCUMENT, async () => {
          lockTaken.notify();
          await held;
        }),
      );
      try {
        await lockTaken.wait();
        const registering = newRegistry(database).register([registrationFor(scheme)]);
        await waitForWaiters(arrivalKey(scheme), 1);
        release();
        const [arrivalSettled] = await Promise.all([arrival, registering]);
        expect(arrivalSettled).toBe(0); // the row did not exist yet; registration saw the document
        expect(await settledIds()).toEqual([DOCUMENT]);
      } finally {
        release();
        await arrival.catch(() => undefined);
      }
    }

    /** Registration queues ahead of the arrival, then the arrival's CAS settles it. */
    async function raceRegistrationFirst(scheme: Scheme) {
      // The gate holds the key so registration and then the arrival queue in a known order.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gateTaken = notification("gate lock");
      const gate = gateTaken.from(
        runInDrizzleTransaction(gateConnection, async () => {
          // Namespace key only: a Work-row lock would queue the arrival on the row, not the key.
          await lockNamespaceKeys(gateConnection, [
            {
              projectId: PROJECT,
              userId: USER,
              scheme,
              workId: scheme === "manuscript" ? null : NO_WORK,
            },
          ]);
          gateTaken.notify();
          await held;
        }),
      );
      // The arrival stops after its insert, before settling, so the unsettled row is observable.
      let settle!: () => void;
      const settling = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const inserted = notification("arrival insert");
      let registering: Promise<void> | undefined;
      let arrival: Promise<number> | undefined;
      try {
        await gateTaken.wait();
        registering = newRegistry(database).register([registrationFor(scheme)]);
        await waitForWaiters(arrivalKey(scheme), 1);
        arrival = inserted.from(
          arrive(scheme, DOCUMENT, async () => {
            inserted.notify();
            await settling;
          }),
        );
        await waitForWaiters(arrivalKey(scheme), 2);
        release();
        await registering;
        await inserted.wait();
        expect(await settledIds()).toEqual([null]); // committed before the document existed
        settle();
        expect(await arrival).toBe(1);
        expect(await settledIds()).toEqual([DOCUMENT]);
      } finally {
        release();
        settle();
        await Promise.allSettled([gate, registering, arrival]);
      }
    }

    /** The ref spells AHEAD's address; the awaited document lands under another name. */
    const awaiting = { ...registration, awaitedDocumentId: DOCUMENT as never };
    // Joins the caller's transaction, so a rollback takes the document with it.
    const landMoved = (db: Database = database, id = DOCUMENT) =>
      currentDrizzleDb(db)
        .insert(documents)
        .values({ id, contextSourceId: SOURCE, name: "counted (2)", extension: "toml" });
    /** The awaited document's real arrival: source key, insert at a counted-up name, settle. */
    const awaitedArrival = (db: Database) =>
      runInDrizzleTransaction(db, async () => {
        await lockContextSources(db, [SOURCE]);
        await landMoved(db);
        return newRegistry(db).settleArrivals([DOCUMENT as never]);
      });
    const settledTo = async () =>
      (await database.select().from(linkAheadRefs).where(eq(linkAheadRefs.aheadId, AHEAD)))[0];

    /** Test: a registration and the arrival of the awaited id meet on its stripe, in either order. */
    it("awaiting ref settles to a document landing at another address, registration before arrival and after", async () => {
      // Arrival first, holding the stripe: registration queues, then finds the document live.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stripeTaken = notification("arrival stripe");
      const arrival = stripeTaken.from(
        runInDrizzleTransaction(arrivalConnection, async () => {
          await lockContextSources(arrivalConnection, [SOURCE]);
          await landMoved(arrivalConnection);
          const settled = await newRegistry(arrivalConnection).settleArrivals([DOCUMENT as never]);
          stripeTaken.notify();
          await held;
          return settled;
        }),
      );
      try {
        await stripeTaken.wait();
        const registering = newRegistry(database).register([awaiting]);
        await waitForWaiters(awaitedStripeKey(DOCUMENT), 1);
        release();
        const [arrivalSettled] = await Promise.all([arrival, registering]);
        expect(arrivalSettled).toBe(0); // the row did not exist when the arrival settled
        expect((await settledTo())?.settledDocumentId).toBe(DOCUMENT);
      } finally {
        release();
        await arrival.catch(() => undefined);
      }

      // Registration first: a gate queues it, then the arrival, in a known order.
      await seed();
      let open!: () => void;
      const gateHeld = new Promise<void>((resolve) => {
        open = resolve;
      });
      const gateTaken = notification("stripe gate");
      const gate = gateTaken.from(
        runInDrizzleTransaction(gateConnection, async () => {
          await currentDrizzleDb(gateConnection).execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${awaitedStripeKey(DOCUMENT)}, 0::bigint))`,
          );
          gateTaken.notify();
          await gateHeld;
        }),
      );
      let registering: Promise<void> | undefined;
      let arriving: Promise<number> | undefined;
      try {
        await gateTaken.wait();
        registering = newRegistry(database).register([awaiting]);
        await waitForWaiters(awaitedStripeKey(DOCUMENT), 1);
        arriving = awaitedArrival(arrivalConnection);
        await waitForWaiters(awaitedStripeKey(DOCUMENT), 2);
        open();
        await registering;
        expect(await arriving).toBe(1);
        expect((await settledTo())?.settledDocumentId).toBe(DOCUMENT);
      } finally {
        open();
        await Promise.allSettled([gate, registering, arriving]);
      }
    });

    it("a foreign occupant at the awaited address never captures the link; the awaited document does", async () => {
      await insertDocument(database, "manuscript", DOCUMENT_2); // squatting at the ref's address
      const registry = newRegistry(database);
      await registry.register([awaiting]);
      expect((await settledTo())?.settledDocumentId).toBeNull();
      expect(
        await runInDrizzleTransaction(database, () =>
          registry.settleArrivals([DOCUMENT_2 as never]),
        ),
      ).toBe(0); // the occupant's own arrival: no capture
      await landMoved();
      expect(
        await runInDrizzleTransaction(database, () => registry.settleArrivals([DOCUMENT as never])),
      ).toBe(1);
      expect((await settledTo())?.settledDocumentId).toBe(DOCUMENT);
    });

    it("an awaited document of another project never settles the link", async () => {
      await database
        .insert(projects)
        .values({ id: OTHER_PROJECT, userId: USER, name: "Other", slug: "other-project" });
      await database.insert(contextSources).values({
        id: OTHER_SOURCE,
        projectId: OTHER_PROJECT,
        name: "Manuscript",
        slug: "manuscript",
      });
      await database
        .insert(documents)
        .values({ id: DOCUMENT, contextSourceId: OTHER_SOURCE, name: "other", extension: "toml" });
      const registry = newRegistry(database);
      await registry.register([awaiting]);
      expect(
        await runInDrizzleTransaction(database, () => registry.settleArrivals([DOCUMENT as never])),
      ).toBe(0);
      expect((await settledTo())?.settledDocumentId).toBeNull();
    });

    it("a rolled-back arrival leaves the awaiting ref for the retry", async () => {
      const registry = newRegistry(database);
      await registry.register([awaiting]);
      await expect(
        runInDrizzleTransaction(database, async () => {
          await landMoved(database);
          expect(await registry.settleArrivals([DOCUMENT as never])).toBe(1);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await settledTo()).toMatchObject({
        settledDocumentId: null,
        awaitedDocumentId: DOCUMENT,
      });
      await landMoved();
      expect(
        await runInDrizzleTransaction(database, () => registry.settleArrivals([DOCUMENT as never])),
      ).toBe(1);
    });

    it.each(
      (["arrival", "stop"] as const).flatMap((first) =>
        [false, true].map((rollback) => ({ first, rollback })),
      ),
    )("concurrent Stop versus the awaited arrival first=$first rollback=$rollback keeps the committed winner", async ({
      first,
      rollback,
    }) => {
      await newRegistry(database).register([awaiting]);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const taken = notification("settlement row locked");
      const stop = () => newRegistry(database).releaseAwaiting([DOCUMENT as never]);
      const arrival = () => awaitedArrival(arrivalConnection);
      const producer = taken.from(
        runInDrizzleTransaction(first === "stop" ? database : arrivalConnection, async () => {
          const result = first === "stop" ? await stop() : await arrival();
          taken.notify();
          await held;
          if (rollback) throw new Error("rollback first settlement");
          return result;
        }),
      );
      const ownedProducer = producer.catch((error) => {
        if (!rollback) throw error;
        expect(error.message).toBe("rollback first settlement");
        return null;
      });
      let competitor: Promise<unknown> | undefined;
      try {
        await taken.wait();
        // The competitor is the other operation; a second landing is a retry after the first.
        competitor = first === "stop" ? arrival() : stop();
        for (let attempt = 0; ; attempt++) {
          const waiting = await gateConnection.execute<{ count: number }>(sql`
            SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query ILIKE '%link_ahead_refs%'
          `);
          if ((waiting[0]?.count ?? 0) > 0) break;
          if (attempt >= WAIT_MS / 20) throw new Error("settlement did not contend on the row");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(await settledTo()).toMatchObject({
          settledDocumentId: null,
          awaitedDocumentId: DOCUMENT,
        });
        release();
        await Promise.all([ownedProducer, competitor]);
        // The arrival wins only if it committed or Stop rolled back; a committed Stop frees the
        // ref, and the moved arrival no longer matches it.
        const arrivalWins = first === "arrival" ? !rollback : rollback;
        expect(await settledTo()).toMatchObject({
          settledDocumentId: arrivalWins ? DOCUMENT : null,
          awaitedDocumentId: arrivalWins ? DOCUMENT : null,
        });
      } finally {
        release();
        await Promise.allSettled([ownedProducer, competitor]);
      }
    });

    it("a late registration after Stop waits for its document, and a repeated Stop frees it", async () => {
      const registry = newRegistry(database);
      await registry.register([awaiting]);
      await registry.releaseAwaiting([DOCUMENT as never]);
      await insertDocument(database, "manuscript", DOCUMENT_2); // occupant, after the first Stop
      const late = "00000000-0000-4000-8000-000000000b09";
      await registry.register([{ ...awaiting, aheadId: late }]);
      const lateRow = async () =>
        (await database.select().from(linkAheadRefs).where(eq(linkAheadRefs.aheadId, late)))[0];
      expect(await lateRow()).toMatchObject({
        settledDocumentId: null,
        awaitedDocumentId: DOCUMENT,
      });
      expect(await registry.releaseAwaiting([DOCUMENT as never])).toBe(1);
      expect(await lateRow()).toMatchObject({
        settledDocumentId: DOCUMENT_2,
        awaitedDocumentId: null,
      });
    });

    it("manuscript namespace race settles exactly once in both orders", async () => {
      await raceArrivalFirst("manuscript");
      await seed();
      await raceRegistrationFirst("manuscript");
    });

    // Only the namespace key differs by scheme: scratch and uploads take the same Work key
    // shape and neither is drafted, so one scratch arrival proves registration locks that key.
    it("scratch registration queues on the Work key its arrival holds", async () => {
      await raceArrivalFirst("scratch");
    });

    it("settles an occupied address at registration, once: later occupants and re-registration never retarget", async () => {
      await insertDocument(database);
      const registry = newRegistry(database);
      await registry.register([registration]);
      expect(await settledIds()).toEqual([DOCUMENT]);
      const [first] = await database.select().from(linkAheadRefs);

      // Delete and recreate the address: the compare-and-set must not move the target.
      await database
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, DOCUMENT));
      await insertDocument(database, "manuscript", DOCUMENT_2);
      expect(await registry.settleArrivals([DOCUMENT_2 as never])).toBe(0);
      await registry.register([registration]);
      const [after] = await database.select().from(linkAheadRefs);
      expect(after?.settledDocumentId).toBe(DOCUMENT);
      expect(after?.settledAt).toEqual(first?.settledAt);

      await expect(
        registry.register([{ ...registration, address: "manuscript://other.toml" }]),
      ).rejects.toThrow(/another address/);

      // Registration commits first, so a caller that then rolls back leaves a harmless orphan row.
      const orphan = { ...registration, aheadId: "00000000-0000-4000-8000-000000000b06" };
      await registry.register([orphan]);
      await expect(
        runInDrizzleTransaction(database, async () => {
          throw new Error("caller rolls back");
        }),
      ).rejects.toThrow("caller rolls back");
      expect(await database.select().from(linkAheadRefs)).toHaveLength(2);

      // Inside the caller's transaction the guard throws before anything is written.
      const inside = { ...registration, aheadId: "00000000-0000-4000-8000-000000000b07" };
      await expect(
        runInDrizzleTransaction(database, () => registry.register([inside])),
      ).rejects.toBeInstanceOf(RegistrationInsideTransactionError);
      expect(await database.select().from(linkAheadRefs)).toHaveLength(2);
    });

    it("keeps same-path ahead refs separate for two chat lineages", async () => {
      const ROOTS = [
        "00000000-0000-4000-8000-000000000c01",
        "00000000-0000-4000-8000-000000000c02",
      ];
      const SOURCES = [
        "00000000-0000-4000-8000-000000000c03",
        "00000000-0000-4000-8000-000000000c04",
      ];
      for (const [i, root] of ROOTS.entries()) {
        await database.insert(threads).values({
          id: root,
          projectId: PROJECT,
          createdByUserId: USER,
          rootThreadId: root,
          ref: `c${i + 1}`,
        });
        await database.insert(contextSources).values({
          id: SOURCES[i],
          projectId: PROJECT,
          rootThreadId: root,
          scope: "lineage",
          name: "Scratch",
          slug: "scratch",
        });
      }
      const registry = newRegistry(database);
      await registry.register([
        { ...registration, address: "scratch://@/c1/note.toml" },
        { ...registration, aheadId: DOCUMENT_2, address: "scratch://@/c2/note.toml" },
      ]);
      await database
        .insert(documents)
        .values({ id: DOCUMENT, contextSourceId: SOURCES[0], name: "note", extension: "toml" });
      await runInDrizzleTransaction(database, async () => {
        await lockContextSources(database, [SOURCES[0]]);
        expect(await registry.settleArrivals([DOCUMENT as never])).toBe(1);
      });
      expect(
        await database.select().from(linkAheadRefs).orderBy(linkAheadRefs.aheadId),
      ).toMatchObject([
        { aheadId: AHEAD, rootThreadId: ROOTS[0], settledDocumentId: DOCUMENT },
        { aheadId: DOCUMENT_2, rootThreadId: ROOTS[1], settledDocumentId: null },
      ]);
    });

    it("normalizes ahead ids and requires an exact qualified address", async () => {
      const registry = newRegistry(database);
      await insertDocument(database);
      await registry.register([{ ...registration, aheadId: AHEAD.toUpperCase() }]);
      expect(await database.select().from(linkAheadRefs)).toEqual([
        expect.objectContaining({ aheadId: AHEAD, settledDocumentId: DOCUMENT }),
      ]);
      await registry.register([{ ...registration, aheadId: AHEAD.toUpperCase() }]); // idempotent

      for (const address of [
        "scratch://@/trailing.",
        "scratch://@/.hidden",
        "scratch://@/noext",
        "scratch://contextual.toml",
      ]) {
        await expect(
          registry.register([{ ...registration, aheadId: DOCUMENT_2, address }]),
        ).rejects.toBeInstanceOf(RangeError);
      }
      expect(await database.select().from(linkAheadRefs)).toHaveLength(1);

      // A valid address past PostgreSQL's B-tree tuple limit registers and is found exactly.
      let seed = 913;
      const segment = () =>
        Array.from({ length: 90 }, () => {
          seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
          return String.fromCharCode(0x4e00 + (seed % 18_000));
        }).join("");
      const long = `manuscript://${Array.from({ length: 18 }, segment).join("/")}.toml`;
      const longRegistration = { ...registration, aheadId: DOCUMENT_2, address: long };
      await expect.soft(registry.register([longRegistration])).resolves.toBeUndefined();
      await expect.soft(registry.register([longRegistration])).resolves.toBeUndefined();
      expect
        .soft(
          (
            await database
              .select({ path: linkAheadRefs.path, settled: linkAheadRefs.settledDocumentId })
              .from(linkAheadRefs)
              .where(eq(linkAheadRefs.aheadId, DOCUMENT_2))
          ).map((row) => [`manuscript://${row.path}`, row.settled]),
        )
        .toEqual([[long, null]]);
    });
  });
}
