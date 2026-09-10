/** Real catalog/Work-authority integration for canonical document-link navigation. */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, documents, projects, users, works } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { truncateDrizzleTables } from "../../test-support/drizzle-reset.js";
import { useRollbackTestDatabase } from "../../test-support/rollback-test-database.js";
import { createDrizzleProjectWorkAuthorityResolver } from "../projects/index.js";
import { createDrizzleContextCatalog } from "./adapters/context-catalog.js";
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
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => truncateDrizzleTables(db, [users]),
    });
    beforeEach(async () => {
      const db = database.current;
      await db.insert(users).values(conformanceUserValues(u, "canonical-links"));
      await db.insert(projects).values([
        { id: p, userId: u, name: "Project", slug: "project" },
        { id: personal, userId: u, name: "Personal", slug: "personal", isPersonal: true },
      ]);
      await db.insert(works).values([
        { id: a, projectId: p, createdByUserId: u, name: "A", slug: "work-a" },
        { id: b, projectId: p, createdByUserId: u, name: "B", slug: "work-b" },
      ]);
    });
    function resolver() {
      const db = database.current;
      return createDocumentLinkResolver({
        catalog: createDrizzleContextCatalog(db),
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
        ["user", null, ""],
        ["scratch", b, "@work-b/"],
        ["uploads", b, "@work-b/"],
        ["uploads", null, "@/"],
      ] as const) {
        const id = await add(scheme, "Gate", workId);
        const uri = `${scheme}://${qualifier}Gate.md`;
        expect(
          await r.resolve({ projectId: p, userId: u, workId: a, target: { kind: "scheme", uri } }),
        ).toMatchObject({ documentId: id, uri, workId });
      }
    });
    it("does not search another Work's titles and observes deleted authority", async () => {
      const r = resolver();
      const local = await add("scratch", "Gate", a);
      await add("scratch", "Gate", b);
      expect(
        await r.resolve({
          projectId: p,
          userId: u,
          workId: a,
          target: { kind: "wikilink", name: "Gate" },
        }),
      ).toMatchObject({ documentId: local });
      expect(
        await r.resolve({
          projectId: p,
          userId: u,
          workId: null,
          target: { kind: "wikilink", name: "Gate" },
        }),
      ).toBeNull();
      await database.current.update(works).set({ status: "archived" }).where(eq(works.id, b));
      expect(
        await r.resolve({
          projectId: p,
          userId: u,
          workId: a,
          target: { kind: "scheme", uri: "scratch://@work-b/Gate.md" },
        }),
      ).toBeNull();
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
          target: { kind: "wikilink", name: "Gate" },
        }),
      ).toBeNull();
    });
  });
}
