/** Postgres regression coverage for bootstrap-owned canonical document authority. */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("project bootstrap document authority (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("project bootstrap document authority (postgres)", async () => {
    const { Hocuspocus } = await import("@hocuspocus/server");
    const { createDb } = await import("@meridian/database");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { createCollabDomain } = await import("../collab/composition.js");
    const { createDrizzleResponseObservations } = await import(
      "../runtime/adapters/drizzle-response-observations.js"
    );
    const { createDrizzleProjectBootstrapRepository } = await import("./index.js");
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");

    const USER_ID = "00000000-0000-4000-8000-000000000317";
    const db = createDb(DATABASE_URL, { max: 4 });

    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users]);
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "bootstrap-authority"));
    });

    afterAll(async () => db.$client.end());

    it("freezes the initial authority cut repeatedly without a client opening the document", async () => {
      const collab = createCollabDomain({ db, threads: { findById: async () => null } });
      collab.bindHocuspocus(
        new Hocuspocus({
          yDocOptions: { gc: false, gcFilter: () => true },
          onStoreDocument: ({ documentName, document }) =>
            collab.storeHocuspocusDocument(documentName, document),
        }),
      );
      const bootstrap = await createDrizzleProjectBootstrapRepository({
        db,
        documents: collab,
      }).ensureDefaultBootstrap(USER_ID as never);
      const observations = createDrizzleResponseObservations(db, collab);

      const [first] = await observations.freezeCausalCuts([bootstrap.documentId]);
      const [second] = await observations.freezeCausalCuts([bootstrap.documentId]);
      const markdown = await collab.readAsMarkdown(bootstrap.documentId);

      expect(markdown).toEqual({ ok: true, value: "# Chapter 1\n" });
      expect(first).toMatchObject({
        documentId: bootstrap.documentId,
        generation: 1n,
        admittedThrough: 0n,
      });
      expect(second).toMatchObject({
        documentId: bootstrap.documentId,
        authorityId: first?.authorityId,
        generation: first?.generation,
        admittedThrough: first?.admittedThrough,
      });
    });
  });
}
