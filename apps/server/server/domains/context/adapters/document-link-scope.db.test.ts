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
    // holds a document it created plus one this response staged.
    const membership: LinkScopeMembership = async (view) => {
      const live = [HOLDER, TARGET, SECRET, NOTES, MAP];
      if (!view.workId) return { members: live };
      return {
        members: [...live, DRAFTED, ...(view.responseId === RESPONSE ? [STAGED] : [])],
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
      await db
        .insert(documents)
        .values([
          row(HOLDER, "holder", { folderId: PART }),
          row(TARGET, "target", { folderId: PART }),
          row(DELETED, "gone", { deletedAt: new Date() }),
          row(SECRET, "secret"),
          row(NOTES, "notes"),
          row(DRAFTED, "drafted"),
          row(STAGED, "staged"),
          row(MAP, "map", { folderId: PART, extension: "png", fileType: "image" }),
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
          docs: [holderDoc(stored, [`asset:${MAP}`])],
          addresses: ["manuscript://part1/target"],
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
        expect.soft(scope.isLive(`doc:${TARGET}`)).toBe(true);
        expect.soft(scope.documentFor("manuscript://part1/target")?.documentId).toBe(TARGET);
        expect
          .soft(scope.spellSource({ src: `asset:${MAP}`, ref: null }).href)
          .toBe("part1/map.png");
      });
    });

    it("sees a Work draft's created and same-response staged documents in the draft view only", async () => {
      await scopes.within({ documentId: HOLDER }, async () => {
        await scopes.prepare({
          holders: [
            { documentId: HOLDER, view: DRAFT },
            { documentId: HOLDER, view: LIVE },
          ],
          refs: [`doc:${DRAFTED}`, `doc:${STAGED}`],
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
      });
      expect(await inherited).toBe("moved.md");

      await expect(
        scopes.within({ documentId: HOLDER }, async () => spellTarget()),
      ).rejects.toThrow("no door prepared");
      expect(() => spellTarget()).toThrow("outside a document link scope");
    });
  });
}
