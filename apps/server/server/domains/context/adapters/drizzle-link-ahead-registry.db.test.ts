/**
 * PostgreSQL proof for ahead registration, settlement CAS, and refs written in a draft: registered globally and left unbound until a live document arrives (12a), the writer's own links registered from the review room (L-3).
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - global ahead registration, arrival settlement CAS, and draft-ref deferral (kb/wiki/architecture/documents/links.md#gone-missing-and-ahead)
 */

import { createDb, type Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  linkAheadRefs,
  projects,
  threads,
  users,
  works,
} from "@meridian/database/schema";
import { LIVE } from "@meridian/project-tree";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { branchTreeScenario } from "../../../test-support/branch-tree-scenario.js";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { treeListOfSource, treeSeeder } from "../../../test-support/tree-seed.js";
import { createScopedDocumentLinks } from "../../collab/domain/document-links-port.js";
import {
  createTestDocumentLinkScopes,
  createTestLinkAheadRegistry,
} from "../../collab/test-support/document-link-scopes.js";
import { RegistrationInsideTransactionError } from "../ports/link-ahead-registry.js";
import { lockContextSources } from "./context-fs/document-locations.js";

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
    const _OTHER_PROJECT = "00000000-0000-4000-8000-000000000b0c";
    const _OTHER_SOURCE = "00000000-0000-4000-8000-000000000b0d";
    const SOURCES = {
      manuscript: SOURCE,
      scratch: "00000000-0000-4000-8000-000000000b0b",
    } as const;
    type Scheme = keyof typeof SOURCES;
    const addressFor = (scheme: Scheme) =>
      scheme === "manuscript" ? "manuscript://chapter.toml" : `${scheme}://@w1/chapter.toml`;
    const registrationFor = (scheme: Scheme, aheadId = AHEAD) => ({
      aheadId,
      holderProjectId: PROJECT as never,
      address: addressFor(scheme),
    });
    const registration = registrationFor("manuscript");
    // Registration commits in its own root transaction, so no rollback fixture: reset by FK order.
    const database = createDb(DATABASE_URL, { max: 4 });

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
        handle: "w1",
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
      treeSeeder(db).document(SOURCES[scheme], "chapter.toml", { id });
    const settledIds = async () =>
      (await database.select({ id: linkAheadRefs.settledDocumentId }).from(linkAheadRefs)).map(
        (row) => row.id,
      );
    const newRegistry = (db: Database) => createTestLinkAheadRegistry(db);

    beforeEach(seed);
    afterAll(async () => {
      await deleteDrizzleRows(database, [users]);
      await database.close();
    });

    it("settles an occupied address at registration, once: later occupants and re-registration never retarget", async () => {
      await insertDocument(database);
      const registry = newRegistry(database);
      await registry.register([registration]);
      expect(await settledIds()).toEqual([DOCUMENT]);
      const [first] = await database.select().from(linkAheadRefs);

      // Delete and recreate the address: the compare-and-set must not move the target.
      await treeSeeder(database).store.submit({
        lists: [await treeListOfSource(database, SOURCE)],
        make: ([{ writer }]) => {
          writer.delete(LIVE, "system", DOCUMENT);
        },
      });
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
        { ...registration, address: "scratch://@c1/note.toml" },
        { ...registration, aheadId: DOCUMENT_2, address: "scratch://@c2/note.toml" },
      ]);
      await treeSeeder(database).document(SOURCES[0], "note.toml", { id: DOCUMENT });
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

    describe("written in a draft", () => {
      // Commands publish after commit and registration opens root transactions: commit for real.
      const db = createDb(DATABASE_URL, { max: 12 });
      afterAll(() => db.close());
      const runtimes = useComposedRuntimes(() => db);
      const KAEL = "manuscript://lore/kael";

      async function start() {
        const runtime = await runtimes.compose();
        const scenario = await branchTreeScenario(db, { runtime, runtimes });
        const work = await scenario.work("Ascension", "draft");
        // The model's create is a hidden row in the Work's branch.
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

      it("registers a branch's ref globally and leaves it unbound until a live document arrives (12a)", async () => {
        const { scenario, kael } = await start();
        const registry = createTestLinkAheadRegistry(db);
        const at = { holderProjectId: scenario.project.id, address: KAEL };
        // The branch's hidden document at the path binds nothing, for any holder or mint.
        const typed = crypto.randomUUID();
        await registry.register([{ ...at, aheadId: typed }]);
        await registry.register([{ ...at, aheadId: typed }]);
        expect
          .soft(await registryRow(typed), "registered once, not bound to the branch's document")
          .toEqual({ registered: true, live: null });
        // A model's mint in the branch's view registers the same way.
        const links = createScopedDocumentLinks({
          scopes: createTestDocumentLinkScopes(db),
          registrar: registry,
          viewFor: () => ({ kind: "live" }),
        });
        const minted = crypto.randomUUID();
        await links.registerAhead([{ ref: `ahead:${minted}`, ...at, view: { kind: "live" } }]);
        expect.soft(await registryRow(minted)).toEqual({ registered: true, live: null });
        // The first live arrival at the path (a live create there: the draft's document stays the draft's)
        // binds every waiting ref, once.
        const live = await scenario.writer.createDocument("lore/kael", "Kael, live.");
        for (const aheadId of [typed, minted]) {
          expect.soft(await registryRow(aheadId), "bound to the live document").toEqual({
            registered: true,
            live,
          });
        }
        expect.soft(live, "a live create at the address makes its own document").not.toBe(kael);
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
          link(ghost, "scratch://@w98/notes")(doc);
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
