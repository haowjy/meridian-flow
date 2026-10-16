/**
 * PostgreSQL proof for the document-link scope: batched prepare, views, snapshot lifetime,
 * and how a link reads per view (contract §10: "in a draft", precedence, the pinned holder).
 */
import type { DocumentId } from "@meridian/contracts/runtime";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  drafts,
  draftTreeChanges,
  folders,
  linkAheadRefs,
  projects,
  threads,
  users,
  works,
} from "@meridian/database/schema";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
import { draftTreeScenario } from "../../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createScopedDocumentLinks, liveViewFor } from "../../collab/domain/document-links-port.js";
import { createLinkScopeObserver } from "../../collab/index.js";
import type { FileAccess } from "../../file-policy/index.js";
import { createDrizzleDocumentLinkScopes } from "./document-link-scope.js";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN =
  (process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true") && DATABASE_URL;

const id = (n: number) => `00000000-0000-4000-8000-000000000c${n.toString(16).padStart(2, "0")}`;
const USER = id(1);
const PROJECT = id(2);
const OTHER_PROJECT = id(3);
const SOURCE = id(4);
const OTHER_SOURCE = id(5);
const PART = id(6);
const HOLDER = id(7);
const TARGET = id(8);
const DELETED = id(9);
const FOREIGN = id(10);
const SECRET = id(11);
const NOTES = id(12);
const MAP = id(13);
const DRAFTED = id(14);
const STAGED = id(15);
const SETTLED_AHEAD = id(16);
const OPEN_AHEAD = id(17);
const WORK = id(18);
const SEAL = id(19);
const OLD_CREST = id(20);
const CREST = id(21);
const THREAD = id(22);
const UNKNOWN_THREAD = id(23);
const MISSING_ASSET = id(24);
const WRECK = id(26);
const RETIRED_SOURCE = id(27);
const RETIRED_IMAGE = id(28);
const RETIRED_CHAT = id(29);
const LIVE = { kind: "live" } as const;

const schema = buildDocumentSchema();

/** A holder whose Yjs text carries one occurrence per stored `[ref, href]`. */
function holderDoc(links: readonly (readonly [string, string])[], sources: readonly string[] = []) {
  const doc = new Y.Doc({ gc: false });
  const paragraph = schema.node(
    "paragraph",
    null,
    links.flatMap(([ref, href], index) => [
      schema.text(`link${index}`, [schema.marks.link.create({ href, ref })]),
      schema.text(" "),
    ]),
  );
  const images = sources.map((src) =>
    schema.node("paragraph", null, [schema.node("image", { src, alt: "map" })]),
  );
  prosemirrorToYXmlFragment(
    schema.node("doc", null, [paragraph, ...images]),
    doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
  );
  return doc;
}

/** The file policy's list path, with one document the reader may not read. */
const fileAccess: Pick<FileAccess, "listAccess"> = {
  async listAccess(_principal, ids) {
    return new Map(
      ids.filter((each) => each !== SECRET).map((each) => [each, { level: "read" } as never]),
    ) as Map<DocumentId, never>;
  },
};

if (!RUN) {
  describe.skip("document-link scope (postgres)", () => {});
} else {
  describe("document-link scope (postgres)", () => {
    const db = createDb(DATABASE_URL, { max: 4 });
    const scopes = createDrizzleDocumentLinkScopes({
      db,
      fileAccess,
      observer: createLinkScopeObserver(),
    });

    async function seed() {
      await deleteDrizzleRows(db, [users]);
      await db.insert(users).values(conformanceUserValues(USER, "document-link-scope"));
      await db.insert(projects).values([
        { id: PROJECT, userId: USER, name: "Serial", slug: "serial" },
        { id: OTHER_PROJECT, userId: USER, name: "Other", slug: "other" },
      ]);
      await db.insert(contextSources).values([
        { id: SOURCE, projectId: PROJECT, name: "Manuscript", slug: "manuscript", isPrimary: true },
        { id: OTHER_SOURCE, projectId: OTHER_PROJECT, name: "Manuscript", slug: "manuscript" },
      ]);
      // A retired lineage Scratch source keeps its documents.
      await db.insert(threads).values({
        id: RETIRED_CHAT,
        projectId: PROJECT,
        rootThreadId: RETIRED_CHAT,
        createdByUserId: USER,
        ref: "c1",
        deletedAt: new Date(),
      } as never);
      await db.insert(contextSources).values({
        id: RETIRED_SOURCE,
        projectId: PROJECT,
        rootThreadId: RETIRED_CHAT,
        scope: "lineage",
        name: "Scratch",
        slug: "scratch",
        deletedAt: new Date(),
      });
      await db.insert(folders).values({ id: PART, contextSourceId: SOURCE, name: "part1" });
      const row = (docId: string, name: string, extra: Record<string, unknown> = {}) => ({
        id: docId,
        contextSourceId: SOURCE,
        name,
        extension: "",
        ...extra,
      });
      await db.insert(documents).values([
        row(HOLDER, "holder", { folderId: PART }),
        row(TARGET, "target", { folderId: PART }),
        row(DELETED, "gone", { deletedAt: new Date() }),
        row(SECRET, "secret"),
        row(NOTES, "notes"),
        row(DRAFTED, "drafted", { hidden: true }),
        row(STAGED, "staged", { hidden: true }),
        row(MAP, "map", { folderId: PART, extension: "png", fileType: "image" }),
        // A deleted picture alone at its path, and one whose path a live picture took.
        row(SEAL, "seal", { extension: "png", fileType: "image", deletedAt: new Date() }),
        row(OLD_CREST, "crest", { extension: "png", fileType: "image", deletedAt: new Date() }),
        row(CREST, "crest", { extension: "png", fileType: "image" }),
        // A discarded draft's picture: a hidden tombstone, never a live or deleted image.
        row(WRECK, "wreck", {
          extension: "png",
          fileType: "image",
          hidden: true,
          deletedAt: new Date(),
        }),
        { id: FOREIGN, contextSourceId: OTHER_SOURCE, name: "foreign", extension: "" },
        {
          id: RETIRED_IMAGE,
          contextSourceId: RETIRED_SOURCE,
          name: "sketch",
          extension: "png",
          fileType: "image",
        },
      ]);
      await db.insert(works).values({
        id: WORK,
        projectId: PROJECT,
        createdByUserId: USER,
        name: "Draft",
        slug: "draft",
      });
      await db
        .insert(drafts)
        .values({ id: id(25), projectId: PROJECT, originWorkId: WORK, createdBy: USER });
      await db.insert(draftTreeChanges).values(
        [DRAFTED, STAGED].map((nodeId) => ({
          draftId: id(25),
          nodeId,
          nodeKind: "document" as const,
          created: true,
        })),
      );
      await db.insert(linkAheadRefs).values([
        {
          aheadId: SETTLED_AHEAD,
          projectId: PROJECT as never,
          scheme: "manuscript",
          path: "notes",
          settledDocumentId: NOTES as never,
          settledAt: new Date(),
        },
        {
          aheadId: OPEN_AHEAD,
          projectId: PROJECT as never,
          scheme: "manuscript",
          path: "later",
        },
      ]);
    }
    it("preloads extension-omitted dotted names independently of other addresses", async () => {
      await db
        .update(documents)
        .set({ name: "config.json", extension: "toml", fileType: "text" })
        .where(eq(documents.id, TARGET));
      for (const addresses of [
        ["manuscript://part1/config.json"],
        ["manuscript://part1/config.json", "manuscript://part1/config.json.toml"],
      ]) {
        await scopes.within({ documentId: HOLDER }, async () => {
          await scopes.prepare({ holders: [{ documentId: HOLDER, view: LIVE }], addresses });
          expect(
            scopes
              .holder({ documentId: HOLDER, view: LIVE })
              .documentFor("manuscript://part1/config.json")?.documentId,
          ).toBe(TARGET);
        });
      }
    });
    it("spells a preloaded historical ahead href canonically", async () => {
      const href = "manuscript://book.md/Chapter 15.md?view=1#scene";
      const stored = [[`ahead:${OPEN_AHEAD}`, href]] as const;
      await scopes.within({ documentId: HOLDER }, async () => {
        await scopes.prepare({
          holders: [{ documentId: HOLDER, view: LIVE }],
          docs: [holderDoc(stored)],
        });
        expect(
          scopes.holder({ documentId: HOLDER, view: LIVE }).spellLink({ ref: stored[0][0], href }),
        ).toEqual({
          href: "../book.md/Chapter 15?view=1#scene",
          address: "manuscript://book.md/Chapter 15",
        });
      });
    });
    // The resolve route's answers run over the composed app, as the route handler wires it.
    const runtimes = useComposedRuntimes(() => db);
    beforeEach(seed);
    afterAll(async () => {
      await deleteDrizzleRows(db, [users]);
      await db.close();
    });

    it("answers ids, settlements and addresses in one prepare, spelling only readable targets in the project", async () => {
      const stored = [
        [`doc:${TARGET}`, "manuscript://stored"],
        [`doc:${DELETED}`, "manuscript://stored"],
        [`doc:${FOREIGN}`, "manuscript://stored"],
        [`doc:${SECRET}`, "manuscript://stored"],
        [`ahead:${SETTLED_AHEAD}`, "manuscript://notes"],
        [`ahead:${OPEN_AHEAD}`, "manuscript://later"],
      ] as const;
      await scopes.within({ documentId: HOLDER }, async () => {
        await scopes.prepare({
          holders: [{ documentId: HOLDER, view: LIVE }],
          docs: [
            holderDoc(stored, [
              `asset:${MAP}`,
              `asset:${SEAL}`,
              `asset:${OLD_CREST}`,
              `asset:${MISSING_ASSET}`,
              `asset:${FOREIGN}`,
              `asset:${WRECK}`,
              `asset:${RETIRED_IMAGE}`,
            ]),
          ],
          addresses: [
            "manuscript://part1/target",
            "manuscript://part1/target.md.md",
            "manuscript://part1/map.png",
            "manuscript://part1/nowhere.png",
          ],
        });
        const scope = scopes.holder({ documentId: HOLDER, view: LIVE });
        const spell = (ref: string) => scope.spellLink({ ref, href: "manuscript://stored" }).href;
        expect.soft(scope.holder.uri).toBe("manuscript://part1/holder");
        expect.soft(spell(`doc:${TARGET}`), "live target, relative").toBe("target");
        expect.soft(spell(`doc:${DELETED}`), "deleted").toBe("manuscript://stored");
        expect.soft(spell(`doc:${FOREIGN}`), "other project").toBe("manuscript://stored");
        expect.soft(spell(`doc:${SECRET}`), "unreadable").toBe("manuscript://stored");
        expect.soft(scope.resolve({ ref: `doc:${SECRET}`, href: "x" })).toEqual({ kind: "gone" });
        expect.soft(spell(`ahead:${SETTLED_AHEAD}`), "settled ahead").toBe("../notes");
        expect
          .soft(
            scope.spellLink({ ref: `ahead:${OPEN_AHEAD}`, href: "manuscript://later" }).href,
            "unsettled ahead keeps its address",
          )
          .toBe("../later");
        expect.soft(scope.isLive({ ref: `doc:${TARGET}`, href: "x" })).toBe(true);
        expect.soft(scope.documentFor("manuscript://part1/target")?.documentId).toBe(TARGET);
        expect.soft(scope.documentFor("manuscript://part1/target.md.md")?.documentId).toBe(TARGET);
        expect
          .soft(scope.spellSource({ src: `asset:${MAP}`, ref: null }).href)
          .toBe("part1/map.png");
        // A deleted picture keeps its path only while it is the sole image there;
        // writing that path back binds the same asset (a save and restore round trip).
        const seal = scope.spellSource({ src: `asset:${SEAL}`, ref: null }).href;
        expect.soft(seal, "sole deleted image").toBe("seal.png");
        expect.soft(scope.assetFor(seal), "its path binds back").toBe(SEAL);
        // Once another picture holds the path, the deleted one spells its own last
        // address in full, as a gone link spells its stored address.
        expect
          .soft(scope.spellSource({ src: `asset:${OLD_CREST}`, ref: null }), "path reused")
          .toEqual({ href: "manuscript://crest.png", address: "manuscript://crest.png" });
        expect.soft(scope.assetFor("crest.png"), "the live picture holds the path").toBe(CREST);
        // No address this project knows (no row, another project's id): an empty
        // destination, which names nothing and carries no id.
        for (const [asset, what] of [
          [MISSING_ASSET, "missing asset"],
          [FOREIGN, "another project's id"],
          [WRECK, "a hidden tombstone"],
        ] as const)
          expect
            .soft(scope.spellSource({ src: `asset:${asset}`, ref: null }), what)
            .toEqual({ href: "", address: null });
        // Retiring a source keeps its documents and their addresses: an image there still
        // spells where it was, so rewriting its holder never drops the `asset:` id (S-L1).
        expect
          .soft(scope.spellSource({ src: `asset:${RETIRED_IMAGE}`, ref: null }), "retired source")
          .toEqual({ href: "scratch://@[c1]/sketch.png", address: "scratch://@[c1]/sketch.png" });
        // A written path outside assets/ binds to the picture there; an unknown one stays literal.
        expect.soft(scope.assetFor("part1/map.png"), "known path").toBe(MAP);
        expect.soft(scope.assetFor("part1/nowhere.png"), "unknown path").toBeNull();
        expect.soft(scope.assetFor("wreck.png"), "a hidden tombstone holds no path").toBeNull();
      });
    });

    it("reports an image lookup in a view it never loaded as a miss, never as an answer (S-L2)", async () => {
      const misses: string[] = [];
      const recorded = createDrizzleDocumentLinkScopes({
        db,
        fileAccess,
        observer: {
          unscoped: (documentId) => misses.push(`unscoped:${documentId}`),
          snapshotMiss: ({ key }) => misses.push(key),
        },
      });
      await recorded.within({ documentId: HOLDER }, async () => {
        await recorded.prepare({
          holders: [{ documentId: HOLDER, view: LIVE }],
          docs: [holderDoc([], [`asset:${MAP}`, `asset:${SEAL}`])],
          addresses: ["manuscript://part1/map.png"],
        });
        const unloaded = recorded.holder({
          documentId: HOLDER,
          view: { kind: "draft", draftId: id(25) },
        });
        expect.soft(unloaded.spellSource({ src: `asset:${MAP}`, ref: null })).toEqual({
          href: "",
          address: null,
        });
        expect.soft(unloaded.assetFor("part1/map.png")).toBeNull();
        expect
          .soft(misses)
          .toEqual(
            expect.arrayContaining([
              `identity:${MAP}`,
              `asset:${MAP}`,
              "manuscript://part1/map.png",
            ]),
          );
        // The live view it did load still answers.
        misses.length = 0;
        const live = recorded.holder({ documentId: HOLDER, view: LIVE });
        expect
          .soft(live.spellSource({ src: `asset:${MAP}`, ref: null }).href)
          .toBe("part1/map.png");
        expect.soft(live.assetFor("seal.png")).toBe(SEAL);
        expect.soft(misses).toEqual([]);
      });
      // A key that names no project (a non-UUID grant) still mints under the holder
      // row's own project, and registration keeps the project the mint recorded.
      const registered: string[] = [];
      const port = createScopedDocumentLinks({
        scopes,
        registrar: {
          async register(rows) {
            registered.push(...rows.map((row) => row.holderProjectId));
          },
        },
        viewFor: liveViewFor,
      });
      await scopes.within({ projectId: "test-project" }, async () => {
        await port.prepare({ documentId: HOLDER, docs: [] });
        await port.registerAhead([
          {
            ref: `ahead:${id(90)}`,
            address: "manuscript://part1/new",
            holderProjectId: port.scopeFor(HOLDER, undefined).holder.projectId,
            view: LIVE,
          },
        ]);
      });
      expect.soft(registered).toEqual([PROJECT]);
    });

    it("names the reader's own draft else the oldest, reads an unbound ahead ref by address in each view, and pins only a holder the reader may name (L-1)", async () => {
      const s = await draftTreeScenario(db, { runtime: await runtimes.compose(), runtimes });
      const [atlas, beacon, cove] = [
        await s.work("Atlas", "draft"),
        await s.work("Beacon", "draft"),
        await s.work("Cove", "draft"),
      ];
      const chapter = await s.seedLive("chapter");
      await s.seedLive("notes");
      // Atlas's draft made Kael first; Beacon's draft joined it (one row, one place).
      const kael = await s.seedHidden(atlas, "lore/kael");
      await s.seedHidden(beacon, "lore/kael", { join: kael });
      const [atlasDraft, beaconDraft] = [await s.draftOf(atlas), await s.draftOf(beacon)];
      await s.draftOf(cove);

      const named = async (view: typeof atlas | "live") => {
        const { answer } = await s.linkAnswer({
          view,
          ref: `doc:${kael}`,
          href: "manuscript://stale",
          baseUri: "manuscript://chapter",
        });
        return answer.state === "document"
          ? [answer.inDraft, answer.draft?.draftId, answer.document.uri]
          : answer.state;
      };
      const atAtlas = [true, atlasDraft.id, "manuscript://lore/kael"];
      expect.soft(await named("live"), "live: the oldest draft, its path").toEqual(atAtlas);
      expect.soft(await named(cove), "a draft not using it: the oldest").toEqual(atAtlas);
      expect.soft(await named(atlas), "its own oldest draft").toEqual(atAtlas);
      expect
        .soft(await named(beacon), "the reader's own draft, where it has it")
        .toEqual([true, beaconDraft.id, "manuscript://lore/kael"]);

      // An ahead ref reads by address in the reader's view until a live document binds it:
      // a draft's hidden document there reads "in a draft" from every view.
      const draftShip = await s.seedHidden(atlas, "ship");
      const unbound = await s.seedAhead("ship");
      const liveAnchor = await s.seedLive("anchor");
      const bound = await s.seedAhead("anchor", { settledTo: liveAnchor });
      const read = async (
        view: typeof atlas | "live",
        ahead: string,
        href: string,
        baseUri: string | null,
        holderDocumentId?: typeof chapter,
      ) => {
        const { answer, holderUri } = await s.linkAnswer({
          view,
          ref: `ahead:${ahead}`,
          href,
          baseUri,
          ...(holderDocumentId ? { holderDocumentId } : {}),
        });
        return {
          id: answer.state === "document" ? answer.document.id : answer.state,
          ...(answer.state === "document" && answer.inDraft ? { inDraft: true } : {}),
          ...(holderUri ? { holderUri } : {}),
        };
      };
      const SHIP = "manuscript://ship";
      const ANCHOR = "manuscript://anchor";
      const CHAPTER = "manuscript://chapter";
      const inShip = { id: draftShip, inDraft: true };
      for (const view of [atlas, beacon, "live"] as const) {
        expect
          .soft(await read(view, unbound, SHIP, CHAPTER), "unbound: in a draft, from any view")
          .toEqual(inShip);
        expect
          .soft(await read(view, bound, ANCHOR, CHAPTER), "bound: the live document")
          .toEqual({ id: liveAnchor });
      }
      expect.soft(await read("live", unbound, SHIP, null), "chat: the same").toEqual(inShip);
      await s.seedHidden(beacon, "ship", { join: draftShip });
      expect
        .soft(await read(beacon, unbound, SHIP, CHAPTER), "joined by another draft")
        .toEqual(inShip);

      // A stale base: the id still pins the holder, and the answer names where it is now.
      expect
        .soft(
          await read("live", bound, ANCHOR, "manuscript://old-chapter", chapter),
          "moved holder",
        )
        .toEqual({ id: liveAnchor, holderUri: CHAPTER });

      // Another account's document is no holder here: knowing its id names nothing, so its
      // location never reaches this reader.
      const stranger = await draftTreeScenario(db);
      const foreign = await stranger.seedLive("unannounced-private-book-title");
      expect
        .soft(await read("live", bound, ANCHOR, null, foreign), "another account's holder, by id")
        .toEqual({ id: liveAnchor });
      expect
        .soft(
          await read(atlas, bound, ANCHOR, "manuscript://unannounced-private-book-title", foreign),
          "by id and by its own address",
        )
        .toEqual({ id: liveAnchor });
    });

    it("answers a direct ahead ref (unregistered, no holder) at a model-created hidden document as in a draft, from live and a draft view", async () => {
      const s = await draftTreeScenario(db, { runtime: await runtimes.compose(), runtimes });
      const atlas = await s.work("Atlas", "draft");
      const ship = await s.model(atlas).create("ship2", "A ship.");
      for (const view of ["live", atlas] as const) {
        const { answer } = await s.linkAnswer({
          view,
          ref: `ahead:${crypto.randomUUID()}`,
          href: "manuscript://ship2",
          baseUri: null,
        });
        expect.soft(answer).toMatchObject({
          state: "document",
          inDraft: true,
          document: { id: ship },
        });
      }
    });

    it("reuses one snapshot in nested scopes, reloads an inherited settled one, and fails a door that never prepared", async () => {
      const spellTarget = () =>
        scopes
          .holder({ documentId: HOLDER, view: LIVE })
          .spellLink({ ref: `doc:${TARGET}`, href: "x" }).href;
      const rename = (name: string) =>
        db.update(documents).set({ name }).where(eq(documents.id, TARGET));
      let inherited: Promise<string> | undefined;
      let stray: Promise<string> | undefined;
      await scopes.within({ projectId: PROJECT }, async () => {
        await scopes.prepare({
          holders: [{ documentId: HOLDER, view: LIVE }],
          refs: [`doc:${TARGET}`],
        });
        await rename("moved");
        // A nested door for the same project joins the open snapshot: no reload.
        expect(await scopes.within({ documentId: HOLDER }, async () => spellTarget())).toBe(
          "target",
        );
        // One whose project can't be found has nothing of its own: it keeps the enclosing one.
        expect
          .soft(await scopes.within({ threadId: UNKNOWN_THREAD }, async () => spellTarget()))
          .toBe("target");
        // A door read in a thread never joins one read in none: it loads its own.
        expect
          .soft(
            await scopes.within({ documentId: HOLDER, viewer: { threadId: THREAD } }, async () => {
              await scopes.prepare({
                holders: [{ documentId: HOLDER, view: LIVE }],
                refs: [`doc:${TARGET}`],
              });
              return spellTarget();
            }),
          )
          .toBe("moved");
        // Work scheduled here outlives the operation and must not read its settled snapshot.
        inherited = new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
          scopes.within({ documentId: HOLDER }, async () => {
            await scopes.prepare({
              holders: [{ documentId: HOLDER, view: LIVE }],
              refs: [`doc:${TARGET}`],
            });
            return spellTarget();
          }),
        );
        // A new holder needs an open snapshot; an inherited settled one answers for nobody.
        stray = new Promise((resolve) => setTimeout(resolve, 20)).then(() => {
          try {
            return spellTarget();
          } catch (error) {
            return (error as Error).message;
          }
        });
      });
      expect(await inherited).toBe("moved");
      expect(await stray).toContain("outside a document link scope");

      await expect(
        scopes.within({ documentId: HOLDER }, async () => spellTarget()),
      ).rejects.toThrow("no door prepared");
      expect(() => spellTarget()).toThrow("outside a document link scope");
    });
  });
}
