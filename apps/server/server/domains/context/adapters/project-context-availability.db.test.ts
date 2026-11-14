/**
 * PostgreSQL proof for project-final lookup authority.
 */
import type { Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  branches,
  contextAvailabilityHeads,
  contextSources,
  projects,
  users,
  works,
} from "@meridian/database/schema";
import { LIVE } from "@meridian/project-tree";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { treeListOfSource, treeSeeder } from "../../../test-support/tree-seed.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createProjectContextDocumentStore } from "../context-source-provisioning.js";
import { createDrizzleContextSources } from "./context-sources.js";
import { createDrizzleProjectContextAvailability } from "./project-context-availability.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("project context availability (postgres)", () => {});
} else {
  describe("project context availability (postgres)", () => {
    const USER = "00000000-0000-4000-8000-000000000911";
    const OTHER = "00000000-0000-4000-8000-000000000912";
    const PROJECT = "00000000-0000-4000-8000-000000000913";
    const FOREIGN_PROJECT = "00000000-0000-4000-8000-000000000914";
    const PERSONAL = "00000000-0000-4000-8000-000000000915";
    const PROJECT_SOURCE = "00000000-0000-4000-8000-000000000916";
    const NONE_SOURCE = "00000000-0000-4000-8000-000000000917";
    const WORK_SOURCE = "00000000-0000-4000-8000-000000000918";
    const USER_SOURCE = "00000000-0000-4000-8000-000000000919";
    const FOREIGN_SOURCE = "00000000-0000-4000-8000-000000000920";
    const WORK = "00000000-0000-4000-8000-000000000921";
    const NO_WORK = "00000000-0000-4000-8000-000000000938";
    const PROJECT_AUTHORITY_KEY = `project:${PROJECT}`;
    const _FOREIGN_PROJECT_AUTHORITY_KEY = `project:${FOREIGN_PROJECT}`;
    const _USER_AUTHORITY_KEY = `user:${USER}`;
    const _OTHER_AUTHORITY_KEY = `user:${OTHER}`;
    const DOCS = [
      "00000000-0000-4000-8000-000000000922",
      "00000000-0000-4000-8000-000000000923",
      "00000000-0000-4000-8000-000000000924",
      "00000000-0000-4000-8000-000000000925",
      "00000000-0000-4000-8000-000000000926",
    ] as const;
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });

    async function seed(db: Database = database.current) {
      await db
        .insert(users)
        .values([
          conformanceUserValues(USER, "availability-user"),
          conformanceUserValues(OTHER, "availability-other"),
        ]);
      await db.insert(projects).values([
        { id: PROJECT, userId: USER, name: "Project", slug: "project" },
        { id: FOREIGN_PROJECT, userId: OTHER, name: "Foreign", slug: "foreign" },
        { id: PERSONAL, userId: USER, name: "Personal", slug: "personal", isPersonal: true },
      ]);
      await db.insert(works).values([
        {
          id: NO_WORK,
          projectId: PROJECT,
          createdByUserId: USER,
          name: "No Work",
          handle: null,
          isNoWork: true,
        },
        {
          id: WORK,
          projectId: PROJECT,
          createdByUserId: USER,
          name: "Branch",
          handle: "w2",
        },
      ]);
      await db.insert(contextSources).values([
        { id: PROJECT_SOURCE, projectId: PROJECT, name: "Manuscript", slug: "manuscript" },
        {
          id: NONE_SOURCE,
          projectId: PROJECT,
          chatThreadId: "00000000-0000-4000-8000-000000000939",
          scope: "chat",
          name: "Uploads",
          slug: "uploads",
        },
        { id: WORK_SOURCE, workId: WORK, scope: "work", name: "Work scratch", slug: "scratch" },
        { id: USER_SOURCE, projectId: PERSONAL, name: "User", slug: "user" },
        { id: FOREIGN_SOURCE, projectId: FOREIGN_PROJECT, name: "Foreign", slug: "manuscript" },
      ]);
      const seeder = treeSeeder(db);
      for (const [index, id] of DOCS.entries()) {
        const sourceId =
          [PROJECT_SOURCE, NONE_SOURCE, WORK_SOURCE, USER_SOURCE, FOREIGN_SOURCE][index] ??
          PROJECT_SOURCE;
        await seeder.document(sourceId, `doc-${index}`, { id });
      }
      return db;
    }

    /** Puts the nodes in Trash through the one writer of the tree. */
    async function trash(db: Database, sourceId: string, ...ids: string[]) {
      await treeSeeder(db).store.submit({
        lists: [await treeListOfSource(db, sourceId)],
        make: ([{ writer }]) => {
          for (const id of ids) writer.delete(LIVE, "system", id);
        },
      });
    }

    /** A branch of the project's Work, for documents that exist only in its draft. */
    async function draftView(db: Database) {
      const [branch] = await db
        .insert(branches)
        .values({
          projectId: PROJECT as never,
          createdBy: USER as never,
          originWorkId: WORK as never,
        })
        .returning({ id: branches.id });
      if (!branch) throw new Error("branch not inserted");
      return { draft: branch.id };
    }

    it("resolves every requested authority and does not disclose foreign or unknown identities", async () => {
      const db = await seed();
      const availability = createDrizzleProjectContextAvailability(db);
      const result = await availability.lookup(
        { projectId: PROJECT as never, documentIds: [...DOCS, DOCS[0]] as never },
        { userId: USER },
      );
      expect(result.resolutions).toHaveLength(5);
      expect(result.resolutions.map((item) => item.kind)).toEqual([
        "available",
        "available",
        "available",
        "available",
        "not-visible",
      ]);
      expect(
        result.resolutions
          .slice(0, 4)
          .map((item) => (item.kind === "available" ? item.authority.kind : "wrong")),
      ).toEqual(["project", "chat", "work", "user"]);
      const unknown = await availability.lookup(
        {
          projectId: PROJECT as never,
          documentIds: ["00000000-0000-4000-8000-999999999999"] as never,
        },
        { userId: USER },
      );
      expect({ ...result.resolutions[4], documentId: "same" }).toEqual({
        ...unknown.resolutions[0],
        documentId: "same",
      });
      await expect(
        availability.lookup({ projectId: PROJECT as never, documentIds: [] }, { userId: OTHER }),
      ).rejects.toThrow("Project not found");
    });

    it("normalizes every foreign identity to the missing-ID privacy shape", async () => {
      const db = await seed();
      const evidence = createInMemoryEventSink();
      const foreignInvalidSource = "00000000-0000-4000-8000-000000000935";
      const foreignInvalidDocument = "00000000-0000-4000-8000-000000000936";
      const foreignHidden = "00000000-0000-4000-8000-000000000937";
      const missingDocument = "00000000-0000-4000-8000-999999999999";
      await db.insert(contextSources).values({
        id: foreignInvalidSource,
        projectId: FOREIGN_PROJECT,
        name: "Foreign invalid",
        slug: "invalid-scheme",
      });
      const seeder = treeSeeder(db);
      await seeder.document(foreignInvalidSource, "private", { id: foreignInvalidDocument });
      await seeder.document(FOREIGN_SOURCE, "draft-only.json", {
        id: foreignHidden,
        view: await draftView(db),
      });

      const result = await createDrizzleProjectContextAvailability(db, evidence).lookup(
        {
          projectId: PROJECT as never,
          documentIds: [missingDocument, DOCS[4], foreignHidden, foreignInvalidDocument] as never,
        },
        { userId: USER },
      );
      const normalized = result.resolutions.map(({ documentId: _, ...resolution }) =>
        JSON.stringify(resolution),
      );
      expect(new Set(normalized)).toEqual(new Set([normalized[0]]));
      expect(result.resolutions[0]).toEqual({
        kind: "not-visible",
        documentId: missingDocument,
        checkedGeneration: expect.any(String),
      });
      expect(evidence.events).toEqual([]);
    });

    it("resolves manuscript and user sources distinctly on the actor's personal project", async () => {
      const db = await seed();
      const personalManuscriptSource = "00000000-0000-4000-8000-000000000930";
      const personalManuscriptDocument = "00000000-0000-4000-8000-000000000931";
      await db.insert(contextSources).values({
        id: personalManuscriptSource,
        projectId: PERSONAL,
        name: "Personal manuscript",
        slug: "manuscript",
      });
      await treeSeeder(db).document(personalManuscriptSource, "chapter", {
        id: personalManuscriptDocument,
      });
      const result = await createDrizzleProjectContextAvailability(db).lookup(
        {
          projectId: PERSONAL as never,
          documentIds: [personalManuscriptDocument, DOCS[3]] as never,
        },
        { userId: USER },
      );
      expect(result.resolutions).toMatchObject([
        { kind: "available", authority: { kind: "project", projectId: PERSONAL } },
        { kind: "available", authority: { kind: "user", userId: USER } },
      ]);
    });

    it("does not expose a non-user source from another personal project", async () => {
      const db = await seed();
      const otherPersonalSource = "00000000-0000-4000-8000-000000000933";
      const otherPersonalDocument = "00000000-0000-4000-8000-000000000934";
      await db.insert(contextSources).values({
        id: otherPersonalSource,
        projectId: PERSONAL,
        name: "Other manuscript",
        slug: "manuscript",
      });
      await treeSeeder(db).document(otherPersonalSource, "private", { id: otherPersonalDocument });
      const result = await createDrizzleProjectContextAvailability(db).lookup(
        { projectId: PROJECT as never, documentIds: [otherPersonalDocument] as never },
        { userId: USER },
      );
      expect(result.resolutions).toMatchObject([{ kind: "not-visible" }]);
    });

    it("keeps archived Work documents available, and answers a trashed document as deleted whatever its authority", async () => {
      const db = await seed();
      const availability = createDrizzleProjectContextAvailability(db);
      await db
        .insert(contextAvailabilityHeads)
        .values({ authorityKey: PROJECT_AUTHORITY_KEY, generation: 7n });
      const generation = "7";
      await trash(db, PROJECT_SOURCE, DOCS[0]);
      await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, WORK));
      let result = await availability.lookup(
        { projectId: PROJECT as never, documentIds: [DOCS[0], DOCS[2]] as never },
        { userId: USER },
      );
      expect(result.resolutions).toMatchObject([
        { kind: "deleted", generation },
        {
          kind: "available",
          generation,
          authority: { kind: "work", projectId: PROJECT, workId: WORK },
        },
      ]);
      await db.update(works).set({ deletedAt: new Date() }).where(eq(works.id, WORK));
      await expect(
        availability.lookup(
          { projectId: PROJECT as never, documentIds: [DOCS[2]] as never },
          { userId: USER },
        ),
      ).resolves.toMatchObject({
        resolutions: [{ kind: "authority-unavailable", reason: "work_deleted" }],
      });
      await trash(db, WORK_SOURCE, DOCS[2]);
      await expect(
        availability.lookup(
          { projectId: PROJECT as never, documentIds: [DOCS[2]] as never },
          { userId: USER },
        ),
      ).resolves.toMatchObject({ resolutions: [{ kind: "deleted" }] });
      await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, PROJECT));
      result = await availability.lookup(
        { projectId: PROJECT as never, documentIds: [DOCS[1]] as never },
        { userId: USER },
      );
      expect(result.resolutions[0]).toMatchObject({
        kind: "authority-unavailable",
        reason: "project_deleted",
      });
    });

    it("fences and restores a user source with its personal backing project", async () => {
      const db = await seed();
      const availability = createDrizzleProjectContextAvailability(db);
      const sources = createDrizzleContextSources(db);
      const userDocuments = async () =>
        (
          await Promise.all(
            (await sources.ofUser(USER as never)).map((source) => sources.liveDocuments(source.id)),
          )
        )
          .flat()
          .map((file) => file.id);

      expect(await userDocuments()).toContain(DOCS[3]);

      await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, PERSONAL));
      const provisioned = createProjectContextDocumentStore(db, PROJECT, "user", USER);

      await expect(provisioned.existingContextSourceId()).resolves.toBeNull();
      await expect(
        availability.lookup(
          { projectId: PROJECT as never, documentIds: [DOCS[3]] as never },
          { userId: USER },
        ),
      ).resolves.toMatchObject({
        resolutions: [{ kind: "authority-unavailable", reason: "project_deleted" }],
      });
      expect(await userDocuments()).toEqual([]);

      await db.update(projects).set({ deletedAt: null }).where(eq(projects.id, PERSONAL));

      await expect(provisioned.existingContextSourceId()).resolves.toBe(USER_SOURCE);
      await expect(
        availability.lookup(
          { projectId: PROJECT as never, documentIds: [DOCS[3]] as never },
          { userId: USER },
        ),
      ).resolves.toMatchObject({
        resolutions: [{ kind: "available", entry: { uri: "user://doc-3" } }],
      });
      expect(await userDocuments()).toContain(DOCS[3]);
    });

    it("hides draft-only identities from live availability", async () => {
      const db = await seed();
      const evidence = createInMemoryEventSink();
      const hiddenId = "00000000-0000-4000-8000-000000000927";
      await treeSeeder(db).document(PROJECT_SOURCE, "draft-only.json", {
        id: hiddenId,
        view: await draftView(db),
      });
      const availability = createDrizzleProjectContextAvailability(db, evidence);
      const result = await availability.lookup(
        { projectId: PROJECT as never, documentIds: [hiddenId] as never },
        { userId: USER },
      );
      expect(result.resolutions).toEqual([
        expect.objectContaining({ kind: "not-visible", documentId: hiddenId }),
      ]);
      expect(evidence.events).toEqual([]);
    });

    it("reports conflicting requested-project owners for live and tombstoned rows", async () => {
      const db = await seed();
      const evidence = createInMemoryEventSink();
      const availability = createDrizzleProjectContextAvailability(db, evidence);
      await db.execute(
        sql`alter table context_sources
              drop constraint context_sources_exactly_one_scope,
              drop constraint context_sources_scope_project_fk`,
      );
      await db
        .update(contextSources)
        .set({ workId: WORK })
        .where(eq(contextSources.id, PROJECT_SOURCE));

      const assertInconsistent = async () => {
        const result = await availability.lookup(
          { projectId: PROJECT as never, documentIds: [DOCS[0]] as never },
          { userId: USER },
        );
        expect(result.resolutions).toEqual([
          expect.objectContaining({
            kind: "indeterminate",
            documentId: DOCS[0],
            reason: "identity_inconsistent",
          }),
        ]);
      };
      await assertInconsistent();
      await trash(db, PROJECT_SOURCE, DOCS[0]);
      await assertInconsistent();
      expect(evidence.events).toEqual([
        expect.objectContaining({
          name: "ProjectContextIdentityInconsistent",
          payload: { documentId: DOCS[0], projectId: PROJECT },
        }),
        expect.objectContaining({
          name: "ProjectContextIdentityInconsistent",
          payload: { documentId: DOCS[0], projectId: PROJECT },
        }),
      ]);
    });

    it("resolves folder identity in each source without confusing authority hiding with deletion", async () => {
      const db = await seed();
      const availability = createDrizzleProjectContextAvailability(db);
      const seeder = treeSeeder(db);
      const id = await seeder.folder(PROJECT_SOURCE, "A");
      const workFolder = await seeder.folder(WORK_SOURCE, "Moved");
      const foreign = await seeder.folder(FOREIGN_SOURCE, "Foreign");
      const lookup = async (...ids: string[]) =>
        (
          await availability.lookup(
            { projectId: PROJECT as never, documentIds: [], folderIds: ids },
            { userId: USER },
          )
        ).folderResolutions!;
      expect(await lookup(id, foreign, "00000000-0000-4000-8000-000000000944")).toMatchObject([
        { folderId: id, kind: "available", entry: { path: ["A"], uri: "manuscript://A" } },
        { folderId: foreign, kind: "not-visible" },
        { kind: "not-visible" },
      ]);
      expect((await lookup(workFolder))[0]).toMatchObject({
        kind: "available",
        entry: {
          scope: { kind: "work", workId: WORK },
          path: ["Moved"],
          uri: "scratch://@w2/Moved",
        },
      });
      await db.update(works).set({ deletedAt: new Date() }).where(eq(works.id, WORK));
      expect((await lookup(workFolder))[0].kind).toBe("authority-unavailable");
      await trash(db, WORK_SOURCE, workFolder);
      expect((await lookup(workFolder))[0].kind).toBe("deleted");
    });

    it("rejects invalid schemes, Work authority and scope pairing", async () => {
      const db = await seed();
      const availability = createDrizzleProjectContextAvailability(db);
      const assertIndeterminate = async (documentId: string) => {
        const result = await availability.lookup(
          { projectId: PROJECT as never, documentIds: [documentId] as never },
          { userId: USER },
        );
        expect(result.resolutions[0]).toMatchObject({
          kind: "indeterminate",
          documentId,
          reason: "identity_inconsistent",
        });
      };

      await db
        .update(contextSources)
        .set({ slug: "invalid-scheme" })
        .where(eq(contextSources.id, PROJECT_SOURCE));
      await assertIndeterminate(DOCS[0]);
      await db
        .update(contextSources)
        .set({ slug: "manuscript" })
        .where(eq(contextSources.id, PROJECT_SOURCE));

      await db
        .update(contextSources)
        .set({ slug: "manuscript" })
        .where(eq(contextSources.id, WORK_SOURCE));
      await assertIndeterminate(DOCS[2]);
      await db
        .update(contextSources)
        .set({ slug: "scratch" })
        .where(eq(contextSources.id, WORK_SOURCE));

      await db.execute(sql`alter table works drop constraint works_handle_valid`);
      await db.update(works).set({ handle: "invalid handle" }).where(eq(works.id, WORK));
      await assertIndeterminate(DOCS[2]);
    });
  });
}
