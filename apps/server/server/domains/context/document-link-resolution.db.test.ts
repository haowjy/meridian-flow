/** Real catalog/Work-authority integration for canonical document-link navigation. */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documentLinks,
  documents,
  linkRedirects,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../test-support/drizzle-reset.js";
import { createDrizzleProjectWorkAuthorityResolver } from "../projects/index.js";
import { createDrizzleContextCatalog } from "./adapters/context-catalog.js";
import { DrizzleContextTreeMutationStore } from "./adapters/context-fs/drizzle-tree-mutation-store.js";
import { createDrizzleDocumentLinkHistory } from "./adapters/document-link-history.js";
import { createDocumentLinkResolver } from "./document-link-resolution.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("catalog-backed document links (postgres)", () => {});
} else {
  describe("catalog-backed document links (postgres)", () => {
    const u = "00000000-0000-4000-8000-000000000900";
    const p = "00000000-0000-4000-8000-000000000901";
    const personal = "00000000-0000-4000-8000-000000000902";
    const a = "00000000-0000-4000-8000-000000000903";
    const b = "00000000-0000-4000-8000-000000000904";
    const noWork = "00000000-0000-4000-8000-000000000905";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });
    beforeEach(async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(u, "canonical-links"));
      await db.insert(projects).values([
        { id: p, userId: u, name: "Project", slug: "project" },
        { id: personal, userId: u, name: "Personal", slug: "personal", isPersonal: true },
      ]);
      await db.insert(works).values([
        {
          id: noWork,
          projectId: p,
          createdByUserId: u,
          name: "No Work",
          slug: null,
          isNoWork: true,
        },
        { id: a, projectId: p, createdByUserId: u, name: "A", slug: "work-a" },
        { id: b, projectId: p, createdByUserId: u, name: "B", slug: "work-b" },
      ]);
    });
    function resolver() {
      const db = database.current;
      return createDocumentLinkResolver({
        catalog: createDrizzleContextCatalog(db),
        history: createDrizzleDocumentLinkHistory(db),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
      });
    }
    async function add(scheme: string, name: string, workId: string | null = null) {
      const db = database.current;
      const sourceId = crypto.randomUUID();
      const documentId = crypto.randomUUID();
      await db.insert(contextSources).values({
        id: sourceId,
        slug: scheme,
        name: scheme,
        scope: workId ? "work" : "project",
        projectId: workId ? null : scheme === "user" ? personal : p,
        workId,
      });
      await db
        .insert(documents)
        .values({ id: documentId, contextSourceId: sourceId, name, extension: "md" });
      return documentId;
    }
    it("opens all canonical schemes, explicit other Work and no-Work targets", async () => {
      const r = resolver();
      for (const [scheme, workId, qualifier] of [
        ["manuscript", null, ""],
        ["kb", null, ""],
        ["unfiled", null, ""],
        ["user", null, ""],
        ["scratch", b, "@work-b/"],
        ["uploads", b, "@work-b/"],
        ["uploads", noWork, "@/"],
      ] as const) {
        const id = await add(scheme, "Gate", workId);
        const uri = `${scheme}://${qualifier}Gate.md`;
        expect(
          await r.resolve({ projectId: p, userId: u, workId: a, target: { kind: "scheme", uri } }),
        ).toMatchObject({
          documentId: id,
          uri,
          workId,
        });
      }
    });
    it("resolves a contextual address in the current Work only, and archived but not deleted authority", async () => {
      const r = resolver();
      const local = await add("scratch", "Gate", a);
      await add("scratch", "Gate", b);
      expect(
        await r.resolve({
          projectId: p,
          userId: u,
          workId: a,
          target: { kind: "scheme", uri: "scratch://Gate.md" },
        }),
      ).toMatchObject({ documentId: local });
      expect(
        await r.resolve({
          projectId: p,
          userId: u,
          workId: null,
          target: { kind: "scheme", uri: "scratch://Gate.md" },
        }),
      ).toBeNull();
      await database.current.update(works).set({ archivedAt: new Date() }).where(eq(works.id, b));
      expect(
        await r.resolve({
          projectId: p,
          userId: u,
          workId: a,
          target: { kind: "scheme", uri: "scratch://@work-b/Gate.md" },
        }),
      ).toMatchObject({ scheme: "scratch", path: "Gate.md" });
      await database.current.update(works).set({ deletedAt: new Date() }).where(eq(works.id, b));
      expect(
        await r.resolve({
          projectId: p,
          userId: u,
          workId: a,
          target: { kind: "scheme", uri: "scratch://@work-b/Gate.md" },
        }),
      ).toBeNull();
      await database.current
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, local));
      expect(
        await r.resolve({
          projectId: p,
          userId: u,
          workId: a,
          target: { kind: "scheme", uri: "scratch://Gate" },
        }),
      ).toBeNull();
    });
    it("pending redirects answer holders before rewrite; chat history follows a rename but a new occupant wins", async () => {
      const db = database.current;
      const originalTurn = crypto.randomUUID();
      const targetId = await add("manuscript", "old");
      const [target] = await db.select().from(documents).where(eq(documents.id, targetId));
      if (!target) throw new Error("target fixture missing");
      const holderId = crypto.randomUUID();
      await db.insert(documents).values({
        id: holderId,
        contextSourceId: target.contextSourceId,
        name: "holder",
        extension: "md",
      });
      await db.insert(documentLinks).values({
        sourceDocumentId: holderId,
        href: "old.md",
        targetProjectId: p,
        targetKey: "manuscript://old.md",
        occurrences: 1,
      });
      const tree = new DrizzleContextTreeMutationStore(db);
      const source = await tree.inspect(target.contextSourceId, "old.md");
      if (source?.kind !== "file") throw new Error("source fixture missing");
      expect(
        await tree.commitMove({
          source,
          destinationSourceId: target.contextSourceId,
          destinationPath: "new.md",
          mover: { userId: u, turnId: originalTurn },
          expectedTarget: { state: "absent" },
          overwrite: false,
          graduateProvisionalName: true,
          destinationFiletype: "markdown",
        }),
      ).toMatchObject({ ok: true });
      const r = resolver();
      const input = {
        projectId: p,
        userId: u,
        target: { kind: "scheme" as const, uri: "manuscript://old.md" },
      };
      const holder = { documentId: holderId, href: "old.md" };
      expect(await r.resolve({ ...input, holder })).toMatchObject({
        documentId: targetId,
        uri: "manuscript://new.md",
      });
      expect(await r.resolve(input)).toMatchObject({ documentId: targetId });
      expect(
        await r.resolve({ ...input, holder: { ...holder, href: "newly-typed.md" } }),
      ).toBeNull();
      const occupant = crypto.randomUUID();
      await db.insert(documents).values({
        id: occupant,
        contextSourceId: target.contextSourceId,
        name: "old",
        extension: "md",
      });
      // Moving the new occupant cannot steal the pending href or its original mover.
      const occupied = await tree.inspect(target.contextSourceId, "old.md");
      if (occupied?.kind !== "file") throw new Error("Missing new occupant");
      expect(
        await tree.commitMove({
          source: occupied,
          destinationSourceId: target.contextSourceId,
          destinationPath: "later.md",
          expectedTarget: { state: "absent" },
          overwrite: false,
          graduateProvisionalName: true,
          destinationFiletype: "markdown",
          mover: { userId: u, turnId: crypto.randomUUID() },
        }),
      ).toMatchObject({ ok: true });
      expect(await db.select().from(linkRedirects)).toMatchObject([
        { targetDocumentId: targetId, moverUserId: u, moverTurnId: originalTurn },
      ]);
      // Reinstall an occupant to independently verify current-address precedence.
      await db.update(documents).set({ name: "old" }).where(eq(documents.id, occupant));
      expect(await r.resolve(input)).toMatchObject({ documentId: occupant });
      expect(await r.resolve({ ...input, holder })).toMatchObject({ documentId: targetId });
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, targetId));
      expect(await r.resolve({ ...input, holder })).toBeNull();
      expect(await r.resolve(input)).toMatchObject({ documentId: occupant });
    });
  });
}
