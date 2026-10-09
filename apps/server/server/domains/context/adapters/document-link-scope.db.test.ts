/** PostgreSQL proof for the document-link scope: batched prepare, views, and snapshot lifetime. */
import type { DocumentId } from "@meridian/contracts/runtime";
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  folders,
  linkAheadRefs,
  projects,
  users,
} from "@meridian/database/schema";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createScopedDocumentLinks, liveViewFor } from "../../collab/domain/document-links-port.js";
import { createLinkScopeObserver } from "../../collab/index.js";
import type { FileAccess } from "../../file-policy/index.js";
import {
  createDrizzleDocumentLinkScopes,
  type LinkScopeMembership,
} from "./document-link-scope.js";

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
const RESPONSE = "response-f2";
const LIVE = { kind: "live" } as const;
const DRAFT = { kind: "draft", workId: WORK, responseId: RESPONSE } as const;

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
    // Manifest membership the way ContextFS reads it: live, and a Work draft that
    // removed NOTES and holds a document it created, plus one this response staged
    // in its thread (the real resolver counts staged creates only with both).
    const membership: LinkScopeMembership = async (view) => {
      const live = [HOLDER, TARGET, SECRET, NOTES, MAP, CREST];
      if (!view.workId) return { members: live };
      const staged = view.responseId === RESPONSE && view.threadId === THREAD ? [STAGED] : [];
      return {
        members: [...live.filter((each) => each !== NOTES), DRAFTED, ...staged],
      };
    };
    const scopes = createDrizzleDocumentLinkScopes({
      db,
      fileAccess,
      membership,
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
      await db.insert(folders).values({ id: PART, contextSourceId: SOURCE, name: "part1" });
      const row = (docId: string, name: string, extra: Record<string, unknown> = {}) => ({
        id: docId,
        contextSourceId: SOURCE,
        name,
        extension: "md",
        ...extra,
      });
      await db.insert(documents).values([
        row(HOLDER, "holder", { folderId: PART }),
        row(TARGET, "target", { folderId: PART }),
        row(DELETED, "gone", { deletedAt: new Date() }),
        row(SECRET, "secret"),
        row(NOTES, "notes"),
        row(DRAFTED, "drafted"),
        row(STAGED, "staged"),
        row(MAP, "map", { folderId: PART, extension: "png", fileType: "image" }),
        // A deleted picture alone at its path, and one whose path a live picture took.
        row(SEAL, "seal", { extension: "png", fileType: "image", deletedAt: new Date() }),
        row(OLD_CREST, "crest", { extension: "png", fileType: "image", deletedAt: new Date() }),
        row(CREST, "crest", { extension: "png", fileType: "image" }),
        { id: FOREIGN, contextSourceId: OTHER_SOURCE, name: "foreign", extension: "md" },
      ]);
      await db.insert(linkAheadRefs).values([
        {
          aheadId: SETTLED_AHEAD,
          projectId: PROJECT as never,
          scheme: "manuscript",
          path: "notes.md",
          settledDocumentId: NOTES as never,
          settledAt: new Date(),
        },
        {
          aheadId: OPEN_AHEAD,
          projectId: PROJECT as never,
          scheme: "manuscript",
          path: "later.md",
        },
      ]);
    }
    beforeEach(seed);
    afterAll(async () => {
      await deleteDrizzleRows(db, [users]);
      await db.close();
    });

    it("answers ids, settlements and addresses in one prepare, spelling only readable targets in the project", async () => {
      const stored = [
        [`doc:${TARGET}`, "manuscript://stored.md"],
        [`doc:${DELETED}`, "manuscript://stored.md"],
        [`doc:${FOREIGN}`, "manuscript://stored.md"],
        [`doc:${SECRET}`, "manuscript://stored.md"],
        [`ahead:${SETTLED_AHEAD}`, "manuscript://notes.md"],
        [`ahead:${OPEN_AHEAD}`, "manuscript://later.md"],
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
            ]),
          ],
          addresses: [
            "manuscript://part1/target",
            "manuscript://part1/map.png",
            "manuscript://part1/nowhere.png",
          ],
        });
        const scope = scopes.holder({ documentId: HOLDER, view: LIVE });
        const spell = (ref: string) =>
          scope.spellLink({ ref, href: "manuscript://stored.md" }).href;
        expect.soft(scope.holder.uri).toBe("manuscript://part1/holder.md");
        expect.soft(spell(`doc:${TARGET}`), "live target, relative").toBe("target.md");
        expect.soft(spell(`doc:${DELETED}`), "deleted").toBe("manuscript://stored.md");
        expect.soft(spell(`doc:${FOREIGN}`), "other project").toBe("manuscript://stored.md");
        expect.soft(spell(`doc:${SECRET}`), "unreadable").toBe("manuscript://stored.md");
        expect
          .soft(scope.resolve({ ref: `doc:${SECRET}`, href: "x.md" }))
          .toEqual({ kind: "gone" });
        expect.soft(spell(`ahead:${SETTLED_AHEAD}`), "settled ahead").toBe("../notes.md");
        expect
          .soft(
            scope.spellLink({ ref: `ahead:${OPEN_AHEAD}`, href: "manuscript://later.md" }).href,
            "unsettled ahead keeps its address",
          )
          .toBe("../later.md");
        expect.soft(scope.isLive({ ref: `doc:${TARGET}`, href: "x.md" })).toBe(true);
        expect.soft(scope.documentFor("manuscript://part1/target")?.documentId).toBe(TARGET);
        expect
          .soft(scope.spellSource({ src: `asset:${MAP}`, ref: null }).href)
          .toBe("part1/map.png");
        // A deleted picture keeps its path only while it is the sole image there;
        // writing that path back binds the same asset (a save and restore round trip).
        const seal = scope.spellSource({ src: `asset:${SEAL}`, ref: null }).href;
        expect.soft(seal, "sole deleted image").toBe("seal.png");
        expect.soft(scope.assetFor(seal), "its path binds back").toBe(SEAL);
        expect
          .soft(scope.spellSource({ src: `asset:${OLD_CREST}`, ref: null }).href, "path reused")
          .toBe(`asset:${OLD_CREST}`);
        expect.soft(scope.assetFor("crest.png"), "the live picture holds the path").toBe(CREST);
        // A picture whose asset row is gone entirely is spelled as its ref, which reads back as itself.
        expect
          .soft(
            scope.spellSource({ src: `asset:${MISSING_ASSET}`, ref: null }).href,
            "missing asset",
          )
          .toBe(`asset:${MISSING_ASSET}`);
        // A written path outside assets/ binds to the picture there; an unknown one stays literal.
        expect.soft(scope.assetFor("part1/map.png"), "known path").toBe(MAP);
        expect.soft(scope.assetFor("part1/nowhere.png"), "unknown path").toBeNull();
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
            address: "manuscript://part1/new.md",
            holderProjectId: port.scopeFor(HOLDER, undefined).holder.projectId,
          },
        ]);
      });
      expect.soft(registered).toEqual([PROJECT]);
    });

    it("sees a Work draft's created and same-response staged documents in the draft view only", async () => {
      await scopes.within({ documentId: HOLDER, viewer: { threadId: THREAD } }, async () => {
        await scopes.prepare({
          holders: [
            { documentId: HOLDER, view: DRAFT },
            { documentId: HOLDER, view: LIVE },
          ],
          refs: [`doc:${DRAFTED}`, `doc:${STAGED}`, `doc:${NOTES}`],
        });
        const draft = scopes.holder({ documentId: HOLDER, view: DRAFT });
        const live = scopes.holder({ documentId: HOLDER, view: LIVE });
        for (const [ref, path] of [
          [`doc:${DRAFTED}`, "../drafted.md"],
          [`doc:${STAGED}`, "../staged.md"],
        ] as const) {
          expect.soft(draft.resolve({ ref, href: "x.md" })).toMatchObject({
            kind: "document",
            inDraft: true,
          });
          expect.soft(draft.spellLink({ ref, href: "x.md" }).href).toBe(path);
          expect.soft(live.resolve({ ref, href: "x.md" })).toEqual({ kind: "gone" });
          expect.soft(live.spellLink({ ref, href: "x.md" }).href).toBe("x.md");
        }
        // The draft's own manifest wins: a live document it removed is gone there.
        const notes = { ref: `doc:${NOTES}`, href: "x.md" };
        expect.soft(draft.resolve(notes), "removed in the draft").toEqual({ kind: "gone" });
        expect.soft(live.resolve(notes), "still live").toMatchObject({ kind: "document" });
        // A view whose membership was never loaded is a miss: it keeps the stored href.
        const other = scopes.holder({
          documentId: HOLDER,
          view: { kind: "draft", workId: WORK, responseId: "other-response" },
        });
        expect.soft(other.resolve(notes), "unloaded view").toEqual({ kind: "unknown" });
        expect.soft(other.spellLink(notes).href).toBe("x.md");
      });
      // Read outside the reply's thread, the staged create is not this reader's.
      await scopes.within({ documentId: HOLDER }, async () => {
        await scopes.prepare({
          holders: [{ documentId: HOLDER, view: DRAFT }],
          refs: [`doc:${STAGED}`],
        });
        expect
          .soft(
            scopes
              .holder({ documentId: HOLDER, view: DRAFT })
              .resolve({ ref: `doc:${STAGED}`, href: "x.md" }),
          )
          .toEqual({ kind: "gone" });
      });
    });

    it("reuses one snapshot in nested scopes, reloads an inherited settled one, and fails a door that never prepared", async () => {
      const spellTarget = () =>
        scopes
          .holder({ documentId: HOLDER, view: LIVE })
          .spellLink({ ref: `doc:${TARGET}`, href: "x.md" }).href;
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
          "target.md",
        );
        // One whose project can't be found has nothing of its own: it keeps the enclosing one.
        expect
          .soft(await scopes.within({ threadId: UNKNOWN_THREAD }, async () => spellTarget()))
          .toBe("target.md");
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
          .toBe("moved.md");
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
      expect(await inherited).toBe("moved.md");
      expect(await stray).toContain("outside a document link scope");

      await expect(
        scopes.within({ documentId: HOLDER }, async () => spellTarget()),
      ).rejects.toThrow("no door prepared");
      expect(() => spellTarget()).toThrow("outside a document link scope");
    });
  });
}
