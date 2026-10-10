/** Lane R's rows of the live and draft chokepoint matrices (C-1a, C-1b). */
import { assertThrowawayDatabaseForRunDbTests } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  draftTreeChanges,
  projects,
  userRecentDocuments,
  users,
} from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { draftTreeScenario } from "../../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { createInMemoryCollabDomain } from "../../collab/index.js";
import { createDrizzleFileFacts } from "../../file-policy/adapters/drizzle-file-facts.js";
import { createNoopEventSink } from "../../observability/index.js";
import { createProjectBootstrapRepositoryForTest } from "../../projects/test-support/project-repository.js";
import { createDrizzleRecentDocumentsRepository } from "../../recent-documents/adapters/drizzle/recent-documents-repository.js";
import { RecentDocumentUnavailableError } from "../../recent-documents/ports/recent-documents-repository.js";
import { createInMemoryObjectStore } from "../../storage/index.js";
import { createDrizzleFigureDocumentRepository } from "../adapters/figures/drizzle-figure-document-repository.js";
import { createDrizzleProjectContextAvailability } from "../adapters/project-context-availability.js";
import { createFigureAssetService } from "../figures/figure-assets.js";
import { createDrizzleUploadIntakeRepository } from "../uploads/drizzle-upload-intake.js";
import { createDrizzleUploadIdentityPort } from "../uploads/upload-identity.js";

const url = process.env.DATABASE_URL;
if (process.env.RUN_DB_TESTS !== "1" || !url) {
  describe.skip("independent reader chokepoints", () => {});
} else {
  assertThrowawayDatabaseForRunDbTests(url);
  describe("independent reader chokepoints", () => {
    const database = useRollbackTestDatabase(url, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });
    async function setup() {
      const db = database.current;
      const scenario = await draftTreeScenario(db);
      const work = await scenario.work("Ascension", "draft");
      const id = await scenario.seedHidden(work, "secret/harbor.md");
      const image = await scenario.seedHidden(work, "secret/map.png");
      await db
        .update(documents)
        .set({
          fileType: "image",
          mimeType: "image/png",
          storageUrl: "object://meridian/map.png",
          sizeBytes: 17,
        })
        .where(eq(documents.id, image));
      const tombstones = [
        await scenario.seedHidden(work, "gone.md"),
        await scenario.seedHidden(work, "retired/gone.md"),
      ];
      for (const tombstone of tombstones)
        await db
          .update(documents)
          .set({ deletedAt: new Date() })
          .where(eq(documents.id, tombstone));
      const view = await scenario.drafts.viewForWork(work.id);
      const facts = createDrizzleFileFacts(db);
      const availability = createDrizzleProjectContextAvailability(db);
      const figures = createDrizzleFigureDocumentRepository({ db });
      const objectStore = createInMemoryObjectStore();
      await objectStore.put("map.png", new Uint8Array([1, 2, 3]), "image/png");
      const figureAssets = createFigureAssetService({
        documents: figures,
        objectStore,
        contextPorts: {
          forProject() {
            throw new Error("Read-only matrix never uploads");
          },
        },
        eventSink: createNoopEventSink(),
        signedUrlExpiresAt: () => "2030-01-01T00:00:00Z",
      });
      const recent = createDrizzleRecentDocumentsRepository({ db });
      const input = { projectId: scenario.project.id, documentIds: [id] };
      const actor = { userId: scenario.project.userId };
      return {
        db,
        scenario,
        work,
        id,
        image,
        tombstones,
        view,
        facts,
        availability,
        figures,
        figureAssets,
        recent,
        input,
        actor,
      };
    }

    it("keeps hidden documents out of independent live readers (C-1a)", async () => {
      const s = await setup();
      // A stale recent is pruned when a different live document is recorded.
      await s.db.insert(userRecentDocuments).values({ userId: s.actor.userId, documentId: s.id });
      const live = await s.scenario.seedLive("chapter.md");
      const rows = [
        {
          surface: "hidden tombstone facts",
          run: () =>
            Promise.all(
              s.tombstones.map((documentId) =>
                s.facts.load({ target: { kind: "document", documentId } }),
              ),
            ),
          expected: [null, null],
        },
        {
          surface: "hidden tombstone facts list",
          run: async () => [...(await s.facts.loadList(s.tombstones)).keys()],
          expected: [],
        },
        {
          surface: "hidden tombstone availability",
          run: async () =>
            (await s.availability.lookup({ ...s.input, documentIds: s.tombstones }, s.actor))
              .resolutions,
          expected: s.tombstones.map((documentId) => ({
            kind: "not-visible",
            documentId,
            checkedGeneration: expect.any(String),
          })),
        },
        {
          surface: "file facts list",
          run: async () => (await s.facts.loadList([s.id])).has(s.id),
          expected: false,
        },
        {
          surface: "upload identity batch",
          run: async () =>
            (await createDrizzleUploadIdentityPort(s.db).lookupDocuments([s.id])).length,
          expected: 0,
        },
        {
          surface: "figure host identity",
          run: () => s.figures.documentExistsForProject(s.input.projectId, s.id),
          expected: false,
        },
        {
          surface: "file facts",
          run: () => s.facts.load({ target: { kind: "document", documentId: s.id } }),
          expected: null,
        },
        {
          surface: "availability",
          run: async () => (await s.availability.lookup(s.input, s.actor)).resolutions[0]?.kind,
          expected: "not-visible",
        },
        {
          surface: "figure signed URL without workId",
          run: async () => {
            const result = await s.figureAssets.getSignedFigureUrl({
              projectId: s.input.projectId,
              assetDocumentId: s.image,
            });
            return result.ok ? "signed" : result.error.code;
          },
          expected: "document_not_found",
        },
        {
          surface: "upload identity",
          run: () => createDrizzleUploadIdentityPort(s.db).lookupDocument(s.id),
          expected: null,
        },
        {
          surface: "recents record",
          run: async () => {
            try {
              await s.recent.record(s.actor.userId, s.id);
              return "accepted";
            } catch (error) {
              return error instanceof RecentDocumentUnavailableError ? "unavailable" : error;
            }
          },
          expected: "unavailable",
        },
        {
          surface: "recents list",
          run: async () =>
            (await s.recent.listForProject(s.input.projectId, s.actor.userId)).some(
              (item) => item.documentId === s.id,
            ),
          expected: false,
        },
        {
          surface: "recents prune",
          run: async () => {
            await s.recent.record(s.actor.userId, live);
            return (
              await s.db
                .select()
                .from(userRecentDocuments)
                .where(eq(userRecentDocuments.documentId, s.id))
            ).length;
          },
          expected: 0,
        },
        {
          surface: "upload name allocation",
          run: async () => {
            // Uploads are never drafted in production; this adversarial row verifies the live relation.
            const hidden = await s.scenario.seedHidden(s.work, "upload.md");
            const [source] = await s.db
              .insert(contextSources)
              .values({ workId: s.work.id, scope: "work", name: "Uploads", slug: "uploads" })
              .returning();
            if (!source) throw new Error("Missing uploads source");
            await s.db
              .update(documents)
              .set({ contextSourceId: source.id })
              .where(eq(documents.id, hidden));
            const result = await createDrizzleUploadIntakeRepository(s.db).reserve({
              intakeId: "reader-matrix",
              actorUserId: s.actor.userId,
              owner: { kind: "work", projectId: s.input.projectId, workId: s.work.id },
              filename: "upload.md",
              mimeType: "text/markdown",
              byteDigest: "a".repeat(64),
              fingerprint: "reader-matrix",
              fileType: "markdown",
            });
            return result.kind === "reserved" ? result.reservation.finalPath : result.kind;
          },
          expected: "upload.md",
        },
        {
          surface: "bootstrap chapter lookup",
          run: async () => {
            const hidden = await s.scenario.seedHidden(s.work, "chapter-1.md");
            await s.db
              .update(projects)
              .set({ isPersonal: true })
              .where(eq(projects.id, s.input.projectId));
            const repository = createProjectBootstrapRepositoryForTest({
              db: s.db,
              documents: createInMemoryCollabDomain(),
            });
            return (await repository.ensureDefaultBootstrap(s.actor.userId)).documentId === hidden;
          },
          expected: false,
        },
      ];
      for (const row of rows) expect.soft(await row.run(), row.surface).toEqual(row.expected);
    });

    it("reads independent draft-aware surfaces in the creating draft (C-1b)", async () => {
      const s = await setup();
      const relocated = await s.scenario.seedHidden(s.work, "draft-location/anchor.md");
      const [folder] = await s.db
        .select({ folderId: documents.folderId })
        .from(documents)
        .where(eq(documents.id, relocated));
      if (!folder?.folderId || s.view.kind !== "draft") throw new Error("Missing draft folder");
      await s.db
        .update(draftTreeChanges)
        .set({ parentFolderId: folder.folderId })
        .where(
          and(eq(draftTreeChanges.draftId, s.view.draftId), eq(draftTreeChanges.nodeId, s.id)),
        );
      const rows = [
        {
          surface: "hidden tombstone facts in D",
          run: () =>
            Promise.all(
              s.tombstones.map((documentId) =>
                s.facts.load({ target: { kind: "document", documentId }, draftWorkId: s.work.id }),
              ),
            ),
          expected: [null, null],
        },
        {
          surface: "hidden tombstone facts list in D",
          run: async () => [...(await s.facts.loadList(s.tombstones, s.work.id)).keys()],
          expected: [],
        },
        {
          surface: "hidden tombstone availability in D",
          run: async () =>
            (
              await s.availability.lookup(
                { ...s.input, documentIds: s.tombstones, view: s.view },
                s.actor,
              )
            ).resolutions,
          expected: s.tombstones.map((documentId) => ({
            kind: "not-visible",
            documentId,
            checkedGeneration: expect.any(String),
          })),
        },
        {
          surface: "file facts list in D",
          run: async () => (await s.facts.loadList([s.id], s.work.id)).has(s.id),
          expected: true,
        },
        {
          surface: "file facts in D's folder chain",
          run: async () =>
            (await s.facts.load({ target: { kind: "draft", documentId: s.id, workId: s.work.id } }))
              ?.ancestors[0],
          expected: { kind: "folder", id: folder?.folderId },
        },
        {
          surface: "availability in D",
          run: async () => {
            const result = (await s.availability.lookup({ ...s.input, view: s.view }, s.actor))
              .resolutions[0];
            return result?.kind === "available" ? result.entry.uri : result?.kind;
          },
          expected: "manuscript://draft-location/harbor.md",
        },
        {
          surface: "figure signed URL with workId",
          run: async () => {
            const result = await s.figureAssets.getSignedFigureUrl({
              projectId: s.input.projectId,
              assetDocumentId: s.image,
              view: await s.scenario.drafts.viewForWork(s.work.id),
            });
            return result.ok ? result.value.signedUrl : result.error.code;
          },
          expected: "/memory-object-store/map.png",
        },
      ];
      for (const row of rows) expect.soft(await row.run(), row.surface).toEqual(row.expected);
    });
  });
}
