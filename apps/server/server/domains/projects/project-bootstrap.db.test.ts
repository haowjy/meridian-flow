/**
 * PostgreSQL contract for project bootstrap with locked No Work.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - the default project, Manuscript, first chapter, and locked No Work bootstrap shape
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createAllowAllFileAccess } from "../../domains/file-policy/index.js";
import { createTestRemovalDeps } from "../../test-support/document-removal.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import { NO_AGENT_CARETS } from "../collab/test-support/agent-carets.js";
import { testLinkDeps } from "../collab/test-support/document-link-scopes.js";
import { createTreeReader, LIVE_TREE } from "../context/tree/tree-view.js";
import { createProjectBootstrapRepositoryForTest as createDrizzleProjectBootstrapRepository } from "./test-support/project-repository.js";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN || !DATABASE_URL) describe.skip("project bootstrap (postgres)", () => {});
else
  describe("project bootstrap (postgres)", async () => {
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { eq } = await import("drizzle-orm");
    const { createCollabDomain } = await import("../collab/composition.js");
    const { useRollbackTestDatabase, deleteDrizzleRows } = await import(
      "../../test-support/drizzle-reset.js"
    );
    const USER_ID = "00000000-0000-4000-8000-000000000751";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [schema.users]),
    });
    let db = database.current;
    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "no-work-bootstrap"));
    });
    function collab() {
      const domain = createCollabDomain({
        ...testLinkDeps(db),
        fileAccess: createAllowAllFileAccess(),
        db,
        ...createTestRemovalDeps(db),
        workProjectionMutation: createTestWorkProjectionMutation(db),
        agentCarets: NO_AGENT_CARETS,
      });
      return domain;
    }
    it("converges project, manuscript and locked No Work, with no uploads source and no thread", async () => {
      const repository = createDrizzleProjectBootstrapRepository({
        db,
        treeLists: createTestRemovalDeps(db).treeLists,
        documents: collab(),
      });
      const first = await repository.ensureDefaultBootstrap(USER_ID as never);
      if (!first) throw new Error("The first bootstrap made no project");
      expect(await repository.ensureDefaultBootstrap(USER_ID as never)).toBeNull();
      expect(
        await db
          .select({ slug: schema.projects.slug })
          .from(schema.projects)
          .where(eq(schema.projects.id, first.projectId)),
      ).toEqual([{ slug: "my-serial" }]);
      expect(Object.keys(first).sort()).toEqual([
        "documentId",
        "manuscriptSourceId",
        "projectId",
        "uri",
      ]);
      const [manuscript, workRows, threadRows, docs] = await Promise.all([
        db
          .select({
            slug: schema.contextSources.slug,
            workId: schema.contextSources.workId,
            scope: schema.contextSources.scope,
          })
          .from(schema.contextSources)
          .where(eq(schema.contextSources.projectId, first.projectId)),
        db.select().from(schema.works).where(eq(schema.works.projectId, first.projectId)),
        db.select().from(schema.threads).where(eq(schema.threads.projectId, first.projectId)),
        db.select().from(schema.documents).where(eq(schema.documents.id, first.documentId)),
      ]);
      expect(workRows).toEqual([
        expect.objectContaining({
          isNoWork: true,
          handle: null,
          name: "No Work",
          status: null,
        }),
      ]);
      const noWorkId = workRows[0]?.id;
      const workSources = await db
        .select({
          slug: schema.contextSources.slug,
          workId: schema.contextSources.workId,
          scope: schema.contextSources.scope,
          projectId: schema.contextSources.projectId,
        })
        .from(schema.contextSources)
        .where(eq(schema.contextSources.workId, noWorkId));
      expect(manuscript.map((source) => source.slug).sort()).toEqual([
        "agents",
        "kb",
        "manuscript",
        "unfiled",
      ]);
      expect(
        manuscript.every((source) => source.workId === null && source.scope === "project"),
      ).toBe(true);
      expect(workSources).toEqual([]);
      expect(threadRows).toEqual([]);
      expect(docs).toHaveLength(1);
      expect(
        await createTreeReader(db).findById(LIVE_TREE, first.documentId as never),
      ).toMatchObject({
        kind: "found",
        document: { name: "Chapter 1", extension: "", fileType: "markdown" },
      });
      expect(first.uri).toBe("manuscript://Chapter 1");
    });

    it("rolls back interrupted materialization and provisions cleanly on retry", async () => {
      const domain = collab();
      const interrupted = createDrizzleProjectBootstrapRepository({
        db,
        treeLists: createTestRemovalDeps(db).treeLists,
        documents: {
          ...domain,
          createDocumentAtomically(input) {
            return domain.createDocumentAtomically({
              ...input,
              async initializeContent(documentId) {
                await input.initializeContent(documentId);
                throw new Error("simulated interruption");
              },
            });
          },
        },
      });
      await expect(interrupted.ensureDefaultBootstrap(USER_ID as never)).rejects.toThrow(
        "simulated interruption",
      );
      await expect(
        Promise.all([
          db.select().from(schema.projects),
          db.select().from(schema.documents),
          db.select().from(schema.documentSnapshots),
        ]).then((rows) => rows.map((row) => row.length)),
      ).resolves.toEqual([0, 0, 0]);
      const repaired = await createDrizzleProjectBootstrapRepository({
        db,
        treeLists: createTestRemovalDeps(db).treeLists,
        documents: domain,
      }).ensureDefaultBootstrap(USER_ID as never);
      await expect(domain.readAsMarkdown(repaired?.documentId as never)).resolves.toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
    });

    it("converges a warm empty room with the committed seed", async () => {
      const domain = collab();
      const bootstrap = await createDrizzleProjectBootstrapRepository({
        db,
        treeLists: createTestRemovalDeps(db).treeLists,
        documents: {
          ...domain,
          async seedFromMarkdown(documentId, markdown, origin) {
            (await domain.rooms.read({ kind: "live", documentId })).free();
            return domain.seedFromMarkdown(documentId, markdown, origin);
          },
        },
      }).ensureDefaultBootstrap(USER_ID as never);
      await expect(domain.readAsMarkdown(bootstrap?.documentId as never)).resolves.toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
      await expect(collab().readAsMarkdown(bootstrap?.documentId as never)).resolves.toEqual({
        ok: true,
        value: "# Chapter 1\n",
      });
    });
  });
