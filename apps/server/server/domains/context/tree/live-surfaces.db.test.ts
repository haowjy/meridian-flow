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
import { createApp, toWebHandler } from "nitro/h3";
import { describe, expect, it } from "vitest";
import { createFigureSignedUrlHandler } from "../../../routes/api/projects/[projectId]/documents/[documentId]/figure/signed-url.get.js";
import { draftTreeScenario } from "../../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { drizzleFileAccess } from "../../../test-support/file-grants.js";
import { createInMemoryCollabDomain } from "../../collab/index.js";
import { createDrizzleFileFacts } from "../../file-policy/adapters/drizzle-file-facts.js";
import { createNoopEventSink } from "../../observability/index.js";
import {
  createProjectBootstrapRepositoryForTest,
  createProjectRepositoryForTest,
} from "../../projects/test-support/project-repository.js";
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
      const rival = await scenario.work("Rival", "draft");
      await scenario.seedHidden(rival, "rival.md");
      const foreign = await draftTreeScenario(db);
      const foreignWork = await foreign.work("Foreign", "draft");
      await foreign.seedHidden(foreignWork, "foreign.md");
      const signedObjects: string[] = [];
      const objectStore = createInMemoryObjectStore();
      await objectStore.put("map.png", new Uint8Array([1, 2, 3]), "image/png");
      const figureAssets = createFigureAssetService({
        documents: figures,
        objectStore: {
          put: objectStore.put.bind(objectStore),
          get: objectStore.get.bind(objectStore),
          list: objectStore.list.bind(objectStore),
          delete: objectStore.delete.bind(objectStore),
          async getSignedUrl(key) {
            const result = await objectStore.getSignedUrl(key);
            if (result.ok) signedObjects.push(result.value);
            return result;
          },
        },
        contextPorts: {
          forProject() {
            throw new Error("Read-only matrix never uploads");
          },
        },
        eventSink: createNoopEventSink(),
        signedUrlExpiresAt: () => "2030-01-01T00:00:00Z",
      });
      const services = {
        fileAccess: drizzleFileAccess(db),
        figureAssets,
        projectRepo: createProjectRepositoryForTest({ db }),
        documentSync: { drafts: scenario.drafts },
      };
      async function figureRequest(workId?: string, principal = scenario.project.userId) {
        const app = createApp();
        app.get(
          "/api/projects/:projectId/documents/:documentId/figure/signed-url",
          createFigureSignedUrlHandler(async () => ({
            app: services,
            user: { userId: principal },
          })),
        );
        const query = workId === undefined ? "" : `?workId=${workId}`;
        const before = signedObjects.length;
        const response = await toWebHandler(app)(
          new Request(
            `https://server.local/api/projects/${scenario.project.id}/documents/${image}/figure/signed-url${query}`,
          ),
        );
        return {
          status: response.status,
          body: await response.json(),
          signedObjects: signedObjects.slice(before),
        };
      }
      const deniedFigure = (message = "Document not found") => ({
        status: 404,
        body: { status: 404, message },
        signedObjects: [],
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
        figureRequest,
        deniedFigure,
        rival,
        foreign,
        foreignWork,
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
          run: async () => (await s.availability.lookup(s.input, s.actor)).resolutions[0],
          expected: {
            kind: "not-visible",
            documentId: s.id,
            checkedGeneration: expect.any(String),
          },
        },
        {
          surface: "figure signed URL without workId",
          run: () => s.figureRequest(),
          expected: s.deniedFigure(),
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
          surface: "figure other same-project Work's active draft",
          run: () => s.figureRequest(s.rival.id),
          expected: s.deniedFigure(),
        },
        {
          surface: "figure another project's Work",
          run: () => s.figureRequest(s.foreignWork.id),
          expected: s.deniedFigure(),
        },
        {
          surface: "figure guessed Work",
          run: () => s.figureRequest("00000000-0000-4000-8000-000000009999"),
          expected: s.deniedFigure(),
        },
        {
          surface: "figure foreign principal with creating Work",
          run: () => s.figureRequest(s.work.id, s.foreign.project.userId),
          expected: s.deniedFigure("Project not found"),
        },
        {
          surface: "figure signed URL with workId",
          run: () => s.figureRequest(s.work.id),
          expected: {
            status: 200,
            body: {
              __meridianTransport: true,
              value: {
                assetDocumentId: s.image,
                storageUrl: "object://meridian/map.png",
                mimeType: "image/png",
                fileType: "image",
                signedUrl: "/memory-object-store/map.png",
                signedUrlExpiresAt: "2030-01-01T00:00:00Z",
              },
            },
            signedObjects: ["/memory-object-store/map.png"],
          },
        },
      ];
      for (const row of rows) expect.soft(await row.run(), row.surface).toEqual(row.expected);
    });
  });
}
