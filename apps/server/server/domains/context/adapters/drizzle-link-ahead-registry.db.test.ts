/**
 * PostgreSQL proof for ahead registration, the namespace race with arrival, settlement CAS,
 * and registration in a draft: idempotent per (ref, draft) (L-2), and the writer's own
 * links registered from the review room, never outliving a closed draft (L-3).
 */

import type { DocumentId, DraftId } from "@meridian/contracts";
import { createDb, type Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  linkAheadDraftSettlements,
  linkAheadRefs,
  projects,
  threads,
  users,
  works,
} from "@meridian/database/schema";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  runInDrizzleTransaction,
  runInRootDrizzleTransaction,
  runOutsideDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
import { draftTreeScenario } from "../../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createDrizzleBranchStore } from "../../collab/adapters/drizzle-branches.js";
import { createBranchCoordinator } from "../../collab/domain/branch-coordinator.js";
import { createScopedDocumentLinks } from "../../collab/domain/document-links-port.js";
import {
  aheadRefsIn,
  createDraftBranchAheadRegistration,
} from "../../collab/domain/draft-branch-ahead-registration.js";
import {
  createTestDocumentLinkScopes,
  createTestLinkAheadRegistry,
} from "../../collab/test-support/document-link-scopes.js";
import { RegistrationInsideTransactionError } from "../ports/link-ahead-registry.js";
import {
  contextNamespaceKey,
  lockContextSources,
  lockNamespaceKeys,
} from "./context-fs/document-locations.js";

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
    // Registration commits in its own root transaction, so no rollback fixture: reset by FK order.
    const database = createDb(DATABASE_URL, { max: 4 });
    const arrivalConnection = createDb(DATABASE_URL, { max: 2 });
    const gateConnection = createDb(DATABASE_URL, { max: 2 });

    async function seed() {
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
    const newRegistry = (db: Database) => createTestLinkAheadRegistry(db);

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

    describe("in a draft", () => {
      // Commands publish after commit and registration opens root transactions: commit for real.
      const db = createDb(DATABASE_URL, { max: 12 });
      afterAll(() => db.close());
      const runtimes = useComposedRuntimes(() => db);
      const KAEL = "manuscript://lore/kael";

      async function start() {
        const runtime = await runtimes.compose();
        const scenario = await draftTreeScenario(db, { runtime, runtimes });
        const work = await scenario.work("Ascension", "draft");
        // The model's create is a hidden row in the Work's draft.
        const kael = await scenario.model(work).create("lore/kael", "Kael, the smith.");
        const draft = await scenario.draftOf(work);
        return { runtime, scenario, work, kael, draft };
      }

      /** The ref's registry row, its live settlement, and every draft meaning it has. */
      async function meanings(aheadId: string) {
        const [ref] = await db
          .select({ settled: linkAheadRefs.settledDocumentId })
          .from(linkAheadRefs)
          .where(eq(linkAheadRefs.aheadId, aheadId));
        const drafted = await db
          .select({
            draftId: linkAheadDraftSettlements.draftId,
            documentId: linkAheadDraftSettlements.documentId,
          })
          .from(linkAheadDraftSettlements)
          .where(eq(linkAheadDraftSettlements.aheadId, aheadId));
        return { registered: ref !== undefined, live: ref?.settled ?? null, drafted };
      }
      const inDraft = (draftId: DraftId, documentId: string) => [{ draftId, documentId }];

      it("registers per (ref, draft): a ref already registered live still settles on the draft's occupant, never live; an agent mint keeps its view (L-2)", async () => {
        const { scenario, kael, draft } = await start();
        const registry = createTestLinkAheadRegistry(db);
        const at = { holderProjectId: scenario.project.id, address: KAEL };
        // A live editor's mint at the path, before it ever reached the draft's text.
        const pasted = crypto.randomUUID();
        await registry.register([{ ...at, aheadId: pasted }]);
        expect
          .soft(await meanings(pasted), "live mint: nothing live there, no draft named")
          .toEqual({ registered: true, live: null, drafted: [] });
        // Pasted into the draft's text: its existing row doesn't skip the draft, twice over.
        await registry.register([{ ...at, aheadId: pasted, draftId: draft.id }]);
        await registry.register([{ ...at, aheadId: pasted, draftId: draft.id }]);
        expect
          .soft(await meanings(pasted), "the draft's occupant, once; live untouched")
          .toEqual({ registered: true, live: null, drafted: inDraft(draft.id, kael) });

        // A model's mint carries its holder's view to the registry (B7).
        const links = createScopedDocumentLinks({
          scopes: createTestDocumentLinkScopes(db),
          registrar: registry,
          viewFor: () => ({ kind: "draft", draftId: draft.id }),
        });
        const [minted, liveMinted] = [crypto.randomUUID(), crypto.randomUUID()];
        await links.registerAhead([
          { ref: `ahead:${minted}`, ...at, view: { kind: "draft", draftId: draft.id } },
          { ref: `ahead:${liveMinted}`, ...at, view: { kind: "live" } },
        ]);
        expect
          .soft(await meanings(minted), "minted in the draft's view")
          .toEqual({ registered: true, live: null, drafted: inDraft(draft.id, kael) });
        expect
          .soft(await meanings(liveMinted), "minted live")
          .toEqual({ registered: true, live: null, drafted: [] });
      });

      it("registers the writer's link typed in the draft's review room, and leaves no row past a close it waited on (L-3)", async () => {
        const { runtime, scenario, work, kael, draft } = await start();
        const chapter = await scenario.model(work).create("chapter-two", "The forge was cold.");
        // The client mints the ahead ref as the writer types; the server has never seen it.
        const typeLink = (aheadId: string) => (doc: Y.Doc) => {
          const paragraph = new Y.XmlElement("paragraph");
          const text = new Y.XmlText();
          text.insert(0, "Kael", { link: { href: KAEL, ref: `ahead:${aheadId}`, title: null } });
          paragraph.insert(0, [text]);
          doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).push([paragraph]);
        };
        const draftLinks = runtime.ports.documentSync.draftLinks;
        const typed = crypto.randomUUID();
        await scenario.writer.editDraft(work, chapter, typeLink(typed));
        await draftLinks.flush();
        expect
          .soft(await meanings(typed), "after the debounce, the draft reads it")
          .toEqual({ registered: true, live: null, drafted: inDraft(draft.id, kael) });

        // Apply right after typing, before the debounce: its prerequisite registers the cut.
        const applied = crypto.randomUUID();
        const { branchId } = await scenario.writer.editDraft(work, chapter, typeLink(applied));
        const cut = await draftLinks.prepareDraftLinkPublication({
          draftId: draft.id,
          branchIds: [branchId],
        });
        expect.soft(cut, "the cut Apply's staging fences").toEqual({
          status: "ready",
          cut: {
            draftId: draft.id,
            branches: [{ branchId, documentId: chapter, fingerprint: expect.any(String) }],
          },
          unregistrable: [],
        });
        expect
          .soft(await meanings(applied), "registered in the draft before staging")
          .toEqual({ registered: true, live: null, drafted: inDraft(draft.id, kael) });
        await draftLinks.flush();

        // A live save the draft pulls in, with no journal row and no new generation (F18):
        // the text Apply would publish changed, so the cut must say so.
        const one = await scenario.writer.create("chapter-one", { content: "One." });
        const chapterOne = one.documentId as DocumentId;
        const edit = await scenario.model(work).reply();
        await edit.call("write", {
          command: "insert",
          path: "manuscript://chapter-one",
          find: "One.",
          content: " Two.",
        });
        await edit.save();
        const pulledBranch = await scenario.draftBranch(work, chapterOne);
        const beforePull = await draftLinks.prepareDraftLinkPublication({
          draftId: draft.id,
          branchIds: [pulledBranch.branchId],
        });
        await scenario.writer.write("chapter-one", "One.\n\n[Kael](lore/kael)");
        await runtime.ports.documentSync.flushBranchLivePull(chapterOne);
        const pulledState = await runtime.ports.documentSync.loadHocuspocusBranchState(
          pulledBranch.branchId,
          pulledBranch.generation,
        );
        const pulledDoc = new Y.Doc({ gc: false });
        if (pulledState) Y.applyUpdate(pulledDoc, pulledState.state);
        const [pulled] = aheadRefsIn(pulledDoc);
        expect(pulled, "the live save's ref reached the draft's branch").toBeDefined();
        const afterPull = await draftLinks.prepareDraftLinkPublication({
          draftId: draft.id,
          branchIds: [pulledBranch.branchId],
        });
        const fingerprints = [beforePull, afterPull].map((answer) =>
          answer.status === "ready" ? answer.cut.branches[0]?.fingerprint : answer.status,
        );
        expect.soft(fingerprints[0], "the cut before the pull").toEqual(expect.any(String));
        expect
          .soft(fingerprints[1], "a journal-free pull changes the cut")
          .not.toEqual(fingerprints[0]);
        expect
          .soft(await meanings(pulled?.aheadId ?? ""), "re-registered, the pulled ref means D's")
          .toEqual({ registered: true, live: null, drafted: inDraft(draft.id, kael) });

        // A ref that can never register (its Work doesn't exist) never blocks Apply (F20):
        // the cut is ready and names it unregistrable, and the valid one beside it registers.
        const [ghost, beside] = [crypto.randomUUID(), crypto.randomUUID()];
        await scenario.writer.editDraft(work, chapter, (doc) => {
          typeLink(beside)(doc);
          const paragraph = new Y.XmlElement("paragraph");
          const text = new Y.XmlText();
          text.insert(0, "Notes", {
            link: { href: "scratch://@ghost-work/notes", ref: `ahead:${ghost}`, title: null },
          });
          paragraph.insert(0, [text]);
          doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).push([paragraph]);
        });
        const unregistrable = await draftLinks.prepareDraftLinkPublication({
          draftId: draft.id,
          branchIds: [branchId],
        });
        expect.soft(unregistrable, "a ready cut that names the unregistrable ref").toMatchObject({
          status: "ready",
          cut: { draftId: draft.id, branches: [{ branchId }] },
          unregistrable: [{ aheadId: ghost, address: "scratch://@ghost-work/notes" }],
        });
        expect
          .soft(await meanings(beside), "the independent valid ref still registers")
          .toEqual({ registered: true, live: null, drafted: inDraft(draft.id, kael) });
        expect.soft((await meanings(ghost)).registered, "the refused one has no row").toBe(false);
        await draftLinks.flush();

        // A failure that may pass (a dropped connection) still fails the prerequisite loudly.
        const flaky = crypto.randomUUID();
        await scenario.writer.editDraft(work, chapter, typeLink(flaky));
        await draftLinks.flush();
        await db.delete(linkAheadRefs).where(eq(linkAheadRefs.aheadId, flaky));
        const registry = createTestLinkAheadRegistry(db);
        const interrupted = createDraftBranchAheadRegistration({
          branches: createBranchCoordinator({
            store: createDrizzleBranchStore(db, { drafts: scenario.drafts }),
          }),
          drafts: scenario.drafts,
          registrar: {
            async register(rows) {
              if (rows.some((row) => row.aheadId === flaky)) {
                throw new Error("Connection terminated unexpectedly");
              }
              await registry.register(rows);
            },
          },
          outsideTransaction: runOutsideDrizzleTransaction,
        });
        expect
          .soft(
            await interrupted.prepareDraftLinkPublication({
              draftId: draft.id,
              branchIds: [branchId],
            }),
            "no publication-ready cut after a transient failure",
          )
          .toMatchObject({
            status: "registration_failed",
            failed: [{ aheadId: flaky, reason: "Connection terminated unexpectedly" }],
          });
        expect
          .soft((await meanings(flaky)).registered, "the interrupted ref is unregistered")
          .toBe(false);

        // A close holds the draft while the registration of another typed link waits on it.
        const late = crypto.randomUUID();
        await scenario.writer.editDraft(work, chapter, typeLink(late));
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let locked!: () => void;
        const lockTaken = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const closing = runInRootDrizzleTransaction(db, async () => {
          await scenario.drafts.lockActive(draft.id);
          await scenario.drafts.close(draft.id, new Date());
          locked();
          await held;
        });
        await lockTaken;
        const before = await lockWaiters();
        const registering = draftLinks.flush();
        const waited = await waitFor(async () => (await lockWaiters()) > before);
        release();
        await closing;
        await registering;
        expect.soft(waited, "the registration queued behind the close").toBe(true);
        expect
          .soft(await meanings(late), "registered, naming no closed draft")
          .toEqual({ registered: true, live: null, drafted: [] });
        expect
          .soft((await meanings(typed)).drafted, "the close dropped the earlier meaning too")
          .toEqual([]);
      });

      async function lockWaiters(): Promise<number> {
        const [row] = await db.execute<{ waiting: number }>(sql`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        return Number(row?.waiting ?? 0);
      }
      async function waitFor(condition: () => Promise<boolean>): Promise<boolean> {
        for (let attempt = 0; attempt < 150; attempt++) {
          if (await condition()) return true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return false;
      }
    });
  });
}
