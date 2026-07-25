/** Postgres regression coverage for bootstrap-owned durable document authority head. */

import { beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("project bootstrap document authority head (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("project bootstrap document authority head (postgres)", async () => {
    const { Hocuspocus } = await import("@hocuspocus/server");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("../collab/composition.js");
    const { createDrizzleDocumentAccess } = await import("../../lib/document-access.js");
    const { createDrizzleProjectBootstrapRepository } = await import("./index.js");
    const { useRollbackTestDatabase } = await import(
      "../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { eq } = await import("drizzle-orm");

    const USER_ID = "00000000-0000-4000-8000-000000000317";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      max: 4,
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });
    let db = database.current;

    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "bootstrap-authority"));
    });

    function createBoundCollab() {
      const collab = createCollabDomain({
        db,
        documentAccess: createDrizzleDocumentAccess(db),
      });
      const hocuspocus = new Hocuspocus({
        yDocOptions: { gc: false, gcFilter: () => true },
        onStoreDocument: ({ documentName, document }) =>
          collab.storeHocuspocusDocument(documentName, document),
      });
      collab.bindHocuspocus(hocuspocus);
      return { collab, hocuspocus };
    }

    it("treats repeated bootstrap as initialize-only and preserves writer content", async () => {
      const { collab } = createBoundCollab();
      const repository = createDrizzleProjectBootstrapRepository({ db, documents: collab });
      const first = await repository.ensureDefaultBootstrap(USER_ID as never);
      await collab.writeDocument({
        documentId: first.documentId,
        markdown: "Writer content\n",
        origin: { type: "user", actorUserId: USER_ID as never },
      });
      const checkpointsBefore = await db
        .select({ id: schema.documentYjsCheckpoints.id })
        .from(schema.documentYjsCheckpoints)
        .where(eq(schema.documentYjsCheckpoints.documentId, first.documentId));

      const second = await repository.ensureDefaultBootstrap(USER_ID as never);
      const checkpointsAfter = await db
        .select({ id: schema.documentYjsCheckpoints.id })
        .from(schema.documentYjsCheckpoints)
        .where(eq(schema.documentYjsCheckpoints.documentId, first.documentId));

      expect(second).toEqual(first);
      expect(await collab.readAsMarkdown(first.documentId)).toEqual({
        ok: true,
        value: "Writer content\n",
      });
      expect(checkpointsAfter).toHaveLength(checkpointsBefore.length);
    });

    it("repairs bootstrap rows committed before canonical seeding", async () => {
      const interrupted = createDrizzleProjectBootstrapRepository({
        db,
        documents: {
          async seedFromMarkdown() {
            throw new Error("simulated crash after bootstrap commit");
          },
        },
      });
      await expect(interrupted.ensureDefaultBootstrap(USER_ID as never)).rejects.toThrow(
        "simulated crash",
      );

      const { collab } = createBoundCollab();
      const repaired = await createDrizzleProjectBootstrapRepository({
        db,
        documents: collab,
      }).ensureDefaultBootstrap(USER_ID as never);

      expect(await collab.readAsMarkdown(repaired.documentId)).toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
    });

    it("does not seed over an existing journal when the projection is absent", async () => {
      const interrupted = createDrizzleProjectBootstrapRepository({
        db,
        documents: {
          async seedFromMarkdown() {
            throw new Error("stop before seed");
          },
        },
      });
      await expect(interrupted.ensureDefaultBootstrap(USER_ID as never)).rejects.toThrow();
      const [document] = await db
        .select({ id: schema.documents.id })
        .from(schema.documents)
        .limit(1);
      if (!document) throw new Error("bootstrap document missing");

      const { collab } = createBoundCollab();
      await collab.writeDocument({
        documentId: document.id,
        markdown: "Durable writer draft\n",
        origin: { type: "user", actorUserId: USER_ID as never },
      });
      await createDrizzleProjectBootstrapRepository({
        db,
        documents: collab,
      }).ensureDefaultBootstrap(USER_ID as never);

      expect(await collab.readAsMarkdown(document.id)).toEqual({
        ok: true,
        value: "Durable writer draft\n",
      });
    });

    it("reconciles a warm empty Hocuspocus room with the committed seed", async () => {
      const { collab, hocuspocus } = createBoundCollab();
      let warmConnection: Awaited<ReturnType<typeof hocuspocus.openDirectConnection>> | undefined;
      const bootstrap = await createDrizzleProjectBootstrapRepository({
        db,
        documents: {
          async seedFromMarkdown(documentId, markdown, origin) {
            warmConnection = await hocuspocus.openDirectConnection(documentId, {
              origin: { type: "system", reason: "bootstrap-race" },
            });
            return collab.seedFromMarkdown(documentId, markdown, origin);
          },
        },
      }).ensureDefaultBootstrap(USER_ID as never);

      expect(await collab.readAsMarkdown(bootstrap.documentId)).toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
      await warmConnection?.disconnect();
      const { collab: coldCollab } = createBoundCollab();
      expect(await coldCollab.readAsMarkdown(bootstrap.documentId)).toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
    });
  });
}
