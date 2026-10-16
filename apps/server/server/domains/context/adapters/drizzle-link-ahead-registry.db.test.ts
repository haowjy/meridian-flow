/** Consolidated test contracts; each block retains its original fixture scope. */

import { createHash, randomUUID } from "node:crypto";
import { aheadAddress } from "@meridian/contracts";
import type { WorkId } from "@meridian/contracts/runtime";
import { createDb, type Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  linkAheadRefs,
  projects,
  threads,
  uploadIntakes,
  users,
  works,
} from "@meridian/database/schema";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { and, eq, sql } from "drizzle-orm";
import { describe as __mergedSuite, afterAll, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import { composeAppServices, createProductionAppPorts } from "../../../lib/compose.js";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
import { draftTreeScenario } from "../../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createScopedDocumentLinks } from "../../collab/domain/document-links-port.js";
import {
  createTestDocumentLinkScopes,
  createTestLinkAheadRegistry,
} from "../../collab/test-support/document-link-scopes.js";
import { createNoopEventSink } from "../../observability/index.js";
import { processDetachedWork } from "../../runtime/detached-work.js";
import { createInMemoryObjectStore } from "../../storage/index.js";
import { RegistrationInsideTransactionError } from "../ports/link-ahead-registry.js";
import { createContextUploadContentPort } from "../uploads/context-upload-content.js";
import { createDrizzleUploadIntakeRepository } from "../uploads/drizzle-upload-intake.js";
import { createUploadIntake } from "../uploads/upload-intake.js";
import {
  contextNamespaceKey,
  lockContextSources,
  lockNamespaceKeys,
} from "./context-fs/document-locations.js";
import { DrizzleContextDocumentStore } from "./context-fs/drizzle-store.js";
import { createDrizzleDocumentArrivals } from "./document-arrivals.js";

__mergedSuite("drizzle-link-ahead-registry.db.test.ts", () => {
  // Merged from apps/server/server/domains/context/adapters/drizzle-link-ahead-registry.db.test.ts.
  const DATABASE_URL = process.env.DATABASE_URL;

  const RUN =
    (process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true") && DATABASE_URL;

  if (!RUN) {
    __mergedSuite.skip("ahead-ref registry (postgres)", () => {});
  } else {
    __mergedSuite("ahead-ref registry (postgres)", () => {
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
        const rows = await database.execute<{
          waiting: number;
        }>(sql`
        SELECT count(*)::int AS waiting FROM pg_locks l
        WHERE l.locktype = 'advisory' AND NOT l.granted
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended(${key}, 0::bigint)`);
        return rows[0]?.waiting ?? 0;
      }
      // Every schedule wait is bounded well under the test timeout so cleanup always runs.
      const WAIT_MS = 3000;
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
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return String.fromCharCode(0x4e00 + (seed % 18000));
          }).join("");
        const long = `manuscript://${Array.from({ length: 18 }, segment).join("/")}.toml`;
        const longRegistration = { ...registration, aheadId: DOCUMENT_2, address: long };
        await expect.soft(registry.register([longRegistration])).resolves.toBeUndefined();
        await expect.soft(registry.register([longRegistration])).resolves.toBeUndefined();
        expect
          .soft(
            (
              await database
                .select({
                  path: linkAheadRefs.path,
                  settled: linkAheadRefs.settledDocumentId,
                })
                .from(linkAheadRefs)
                .where(eq(linkAheadRefs.aheadId, DOCUMENT_2))
            ).map((row) => [`manuscript://${row.path}`, row.settled]),
          )
          .toEqual([[long, null]]);
      });
      __mergedSuite("written in a draft", () => {
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
          return { runtime, scenario, work, kael };
        }
        /** The ref's registry row: registered, and the one live document it is bound to. */
        async function registryRow(aheadId: string) {
          const [ref] = await db
            .select({ settled: linkAheadRefs.settledDocumentId })
            .from(linkAheadRefs)
            .where(eq(linkAheadRefs.aheadId, aheadId));
          return { registered: ref !== undefined, live: ref?.settled ?? null };
        }
        it("registers a draft's ref globally and leaves it unbound until a live document arrives (12a)", async () => {
          const { scenario, kael } = await start();
          const registry = createTestLinkAheadRegistry(db);
          const at = { holderProjectId: scenario.project.id, address: KAEL };
          // The draft's hidden document at the path binds nothing, for any holder or mint.
          const typed = crypto.randomUUID();
          await registry.register([{ ...at, aheadId: typed }]);
          await registry.register([{ ...at, aheadId: typed }]);
          expect
            .soft(await registryRow(typed), "registered once, not bound to the draft's document")
            .toEqual({ registered: true, live: null });
          // A model's mint in the draft's view registers the same way.
          const links = createScopedDocumentLinks({
            scopes: createTestDocumentLinkScopes(db),
            registrar: registry,
            viewFor: () => ({ kind: "live" }),
          });
          const minted = crypto.randomUUID();
          await links.registerAhead([{ ref: `ahead:${minted}`, ...at, view: { kind: "live" } }]);
          expect.soft(await registryRow(minted)).toEqual({ registered: true, live: null });
          // The first live arrival at the path (a Create reveals the draft's document, 12b)
          // binds every waiting ref, once.
          const live = await scenario.writer.createDocument("lore/kael", "Kael, live.");
          for (const aheadId of [typed, minted]) {
            expect.soft(await registryRow(aheadId), "bound to the live document").toEqual({
              registered: true,
              live,
            });
          }
          expect.soft(live, "the revealed draft document").toBe(kael);
        });
        it("registers the writer's link typed in the draft's review room, best effort and globally (L-3)", async () => {
          const { runtime, scenario, work } = await start();
          const chapter = await scenario.model(work).create("chapter-two", "The forge was cold.");
          // The client mints the ahead ref as the writer types; the server has never seen it.
          const link =
            (aheadId: string, href = KAEL) =>
            (doc: Y.Doc) => {
              const paragraph = new Y.XmlElement("paragraph");
              const text = new Y.XmlText();
              text.insert(0, "Kael", { link: { href, ref: `ahead:${aheadId}`, title: null } });
              paragraph.insert(0, [text]);
              doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).push([paragraph]);
            };
          const draftLinks = runtime.ports.documentSync.draftLinks;
          const typed = crypto.randomUUID();
          await scenario.writer.editDraft(work, chapter, link(typed));
          await draftLinks.flush();
          expect
            .soft(await registryRow(typed), "after the debounce, registered and unbound")
            .toEqual({ registered: true, live: null });
          // A ref that can never register (its Work doesn't exist) never keeps the valid one
          // beside it from registering.
          const [ghost, beside] = [crypto.randomUUID(), crypto.randomUUID()];
          await scenario.writer.editDraft(work, chapter, (doc) => {
            link(beside)(doc);
            link(ghost, "scratch://@ghost-work/notes")(doc);
          });
          await draftLinks.flush();
          expect.soft((await registryRow(beside)).registered, "the valid ref registers").toBe(true);
          expect
            .soft((await registryRow(ghost)).registered, "the refused one has no row")
            .toBe(false);
        });
      });
    });
  }
});

__mergedSuite("link-ahead-arrivals.db.test.ts", () => {
  // Merged from apps/server/server/domains/context/link-ahead-arrivals.db.test.ts.
  const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  __mergedSuite.skipIf(!enabled || !process.env.DATABASE_URL)(
    "ahead-ref arrivals (postgres)",
    () => {
      // Registration and uploads commit in their own root transactions: committed-data isolation.
      const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 6 });
      const probe = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 2 });
      afterAll(async () => {
        await deleteDrizzleRows(db, [users]);
        await Promise.all([db.close(), probe.close()]);
      });
      const settlement = async (aheadId: string) => {
        const [row] = await db
          .select()
          .from(linkAheadRefs)
          .where(eq(linkAheadRefs.aheadId, aheadId));
        return row?.settledDocumentId ?? null;
      };
      it("create, upload, folder move-in and Work restore each settle once against the final tree", async () => {
        await deleteDrizzleRows(db, [users]);
        const userId = randomUUID();
        const projectId = randomUUID();
        const workId = randomUUID();
        await db.insert(users).values(conformanceUserValues(userId, "ahead-arrivals"));
        await db
          .insert(projects)
          .values({ id: projectId, userId, name: "Arrivals", slug: "arrivals" });
        await db.insert(works).values([
          { projectId, createdByUserId: userId, name: "No Work", isNoWork: true },
          { id: workId, projectId, createdByUserId: userId, name: "Draft", slug: "draft" },
        ]);
        await db.insert(contextSources).values([
          {
            projectId,
            name: "Manuscript",
            slug: "manuscript",
            scope: "project",
            isPrimary: true,
          },
          { workId, name: "Scratch", slug: "scratch", scope: "work" },
        ]);
        const ports = await createProductionAppPorts({
          backgroundTasks: processDetachedWork,
          db,
          eventSink: createNoopEventSink(),
          environment: { FLOW_OPENAI_API_KEY: "sk-test-ahead-arrivals" },
        });
        const app = composeAppServices(ports);
        try {
          const authority = await ports.workAuthorityResolver.byId(projectId, workId);
          if (!authority?.workSlug) throw new Error("Fixture Work missing");
          const port = app.contextPorts.forProject(
            projectId,
            userId,
            new Map([[authority.workSlug, authority]]),
          );
          const register = (address: string) => {
            const aheadId = randomUUID();
            return app.linkAheadRegistry
              .register([{ aheadId, holderProjectId: projectId as never, address }])
              .then(() => aheadId);
          };
          const create = async (uri: string) => {
            const created = await port.createTrackedDocument(uri, "");
            if (!created.ok) throw new Error(JSON.stringify(created.error));
            return created.value.documentId;
          };
          // Tracked create, then delete and recreate at the same path: the second never captures.
          const chapterAddress = aheadAddress("manuscript://ch1.md", "link");
          expect(chapterAddress).toBe("manuscript://ch1");
          const chapter = await register(chapterAddress ?? "");
          expect(await settlement(chapter)).toBeNull();
          const first = await create("manuscript://ch1");
          expect(await settlement(chapter)).toBe(first);
          await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, first));
          const second = await create("manuscript://ch1");
          expect(second).not.toBe(first);
          expect(await settlement(chapter)).toBe(first);
          // A manuscript image: live membership is published after the upload commits.
          const image = await register("manuscript://art/map.png");
          const upload = await port.writeBinary("manuscript://art/map.png", {
            fileType: "image",
            storageUrl: "memory://map.png",
            mimeType: "image/png",
            sizeBytes: 3,
          });
          if (!upload.ok) throw new Error(JSON.stringify(upload.error));
          const [map] = await db
            .select({ id: documents.id })
            .from(documents)
            .where(and(eq(documents.name, "map"), eq(documents.extension, "png")));
          expect(await settlement(image)).toBe(map?.id);
          // The upload's first arrival keeps its ref when the document moves the moment it is live:
          // membership and settlement publish together, so a move cannot slip in between.
          const [manuscript] = await db
            .select({ id: contextSources.id })
            .from(contextSources)
            .where(
              and(eq(contextSources.projectId, projectId), eq(contextSources.slug, "manuscript")),
            );
          if (!manuscript) throw new Error("Fixture Manuscript missing");
          const realArrivals = createDrizzleDocumentArrivals(db, app.linkAheadRegistry);
          const raced = await register("manuscript://race.png");
          let published!: () => void;
          const publication = new Promise<void>((resolve) => {
            published = resolve;
          });
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const racing = new DrizzleContextDocumentStore({
            db,
            contextSourceId: manuscript.id,
            arrivals: {
              lockNamespaces: (ids) => realArrivals.lockNamespaces(ids),
              async settle(ids) {
                published();
                await gate;
                return realArrivals.settle(ids);
              },
            },
          });
          const binary = { fileType: "image", mimeType: "image/png", sizeBytes: 1 } as const;
          const uploading = racing.createBinaryDocument({
            ...binary,
            folderId: null,
            name: "race",
            extension: "png",
            storageUrl: "memory://race.png",
          });
          await publication;
          let moveDone = false;
          const moving = port
            .move("manuscript://race.png", "manuscript://raced.png")
            .finally(() => {
              moveDone = true;
            });
          // The move either finishes in the gap (the defect) or queues behind the upload.
          await until(async () => moveDone || (await lockWaiters(probe)) > 0);
          release();
          const firstUpload = await uploading;
          expect(await moving).toMatchObject({ ok: true });
          expect(await settlement(raced)).toBe(firstUpload.id);
          // A settlement failure fails the upload: nothing is live that a later occupant could
          // take the ref from.
          const failing = await register("manuscript://failure.png");
          const unavailable = async () => {
            throw new Error("settlement unavailable");
          };
          await expect(
            new DrizzleContextDocumentStore({
              db,
              contextSourceId: manuscript.id,
              arrivals: Object.assign({}, realArrivals, {
                settle: unavailable,
                settleCommitted: unavailable,
              }),
            }).createBinaryDocument({
              ...binary,
              folderId: null,
              name: "failure",
              extension: "png",
              storageUrl: "memory://failure.png",
            }),
          ).rejects.toThrow("settlement unavailable");
          expect(
            await db
              .select({ id: documents.id })
              .from(documents)
              .where(and(eq(documents.name, "failure"), eq(documents.extension, "png"))),
          ).toEqual([]);
          expect(await settlement(failing)).toBeNull();
          // Deleting a finalized upload keeps the identity it settled; a new upload at the same
          // address never captures the ref.
          const intake = createUploadIntake({
            repository: createDrizzleUploadIntakeRepository(db),
            content: createContextUploadContentPort(app.contextPorts),
            objectStore: createInMemoryObjectStore(),
            eventSink: createNoopEventSink(),
          });
          const noWorkId = (await ports.workAuthorityResolver.noWork(projectId as never))?.workId;
          for (const [filename, mimeType] of [
            ["delete-target.toml", "application/toml"],
            ["delete-target.png", "image/png"],
          ] as const) {
            const deletedRef = await register(`uploads://@/${filename}`);
            const bytes = new TextEncoder().encode(`Upload ${filename}`);
            const uploadOnce = async () => {
              const uploaded = await intake.intake({
                intakeId: randomUUID(),
                actorUserId: userId,
                owner: { kind: "work", projectId, workId: noWorkId as string },
                filename,
                mimeType,
                byteDigest: createHash("sha256").update(bytes).digest("hex"),
                bytes,
              });
              if (!uploaded.ok) throw new Error(uploaded.error.code);
              return uploaded.value;
            };
            const firstUpload = await uploadOnce();
            expect.soft(await settlement(deletedRef), filename).toBe(firstUpload.documentId);
            const [arrived] = await db
              .select({ intakeId: uploadIntakes.intakeId })
              .from(uploadIntakes)
              .where(eq(uploadIntakes.documentId, firstUpload.documentId as never));
            expect
              .soft(
                await intake.deleteDraft(
                  {
                    intakeId: arrived?.intakeId ?? "",
                    documentId: firstUpload.documentId,
                    uri: firstUpload.uri,
                    expectedRevision: firstUpload.locationRevision,
                  },
                  userId,
                ),
                filename,
              )
              .toEqual({ kind: "deleted" });
            expect.soft(await settlement(deletedRef), filename).toBe(firstUpload.documentId);
            const replacement = await uploadOnce();
            expect.soft(replacement.uri, filename).toBe(firstUpload.uri);
            expect.soft(await settlement(deletedRef), filename).toBe(firstUpload.documentId);
          }
          // A personal document moved into the project arrives there: live in the project, and
          // the ref waiting at the destination settles on it.
          const castRef = await register("kb://cast.toml");
          const cast = await create("user://cast.toml");
          expect(await port.move("user://cast.toml", "kb://cast.toml")).toMatchObject({
            ok: true,
          });
          expect(await settlement(castRef)).toBe(cast);
          // Folder move-in settles against the moved tree; the ref at the vacated path stays put.
          const moved = await create("manuscript://drafts/ch2.toml");
          const vacated = await register("manuscript://drafts/ch2.toml");
          expect(await settlement(vacated)).toBe(moved);
          const destination = await register("manuscript://part-two/ch2.toml");
          expect(await port.move("manuscript://drafts", "manuscript://part-two")).toMatchObject({
            ok: true,
          });
          expect(await settlement(destination)).toBe(moved);
          expect(await settlement(vacated)).toBe(moved);
          // Work restore: the hidden document reappears at its address and settles the waiting ref.
          const notes = await create("scratch://@draft/notes.toml");
          await ports.workRepo.softDelete(workId as WorkId);
          // Registered while the Work is deleted: it keeps its identity, so the ref registers
          // against it and stays unsettled until the restore makes the address live again.
          const waiting = await register("scratch://@draft/notes.toml");
          expect(await settlement(waiting)).toBeNull();
          await ports.workRepo.restore(workId as WorkId);
          expect(await settlement(waiting)).toBe(notes);
        } finally {
          await app.shutdown();
        }
      });
    },
  );

  async function lockWaiters(db: Database): Promise<number> {
    const rows = await db.execute<{
      waiting: number;
    }>(sql`
    SELECT count(*)::int AS waiting FROM pg_locks
    WHERE NOT granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    return rows[0]?.waiting ?? 0;
  }

  async function until(condition: () => Promise<boolean>) {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("condition never held");
  }
});
