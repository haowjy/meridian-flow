/**
 * The chokepoint matrices (contract §16.3, F15): a draft's hidden document is absent from
 * every live surface (C-1a) and present in its draft's view (C-1b). Each matrix is one case
 * iterating its table with `expect.soft` per row, so a failure names every leaking surface.
 * Rows from lanes R (independent readers), C-b (manifest-backed readers moved to the view)
 * and C-a (the catalog and ContextFS, over a document a model created in its draft).
 */

import { randomUUID } from "node:crypto";
import type { LinkView } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import { assertThrowawayDatabaseForRunDbTests } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documentLinks,
  documents,
  draftTreeChanges,
  linkAheadRefs,
  projects,
  userRecentDocuments,
  users,
} from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { createApp, toWebHandler } from "nitro/h3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { downloadDocument } from "../../../lib/document-download-route.js";
import { hasLiveDocument } from "../../../lib/yjs-ws-handler.js";
import { createFigureSignedUrlHandler } from "../../../routes/api/projects/[projectId]/documents/[documentId]/figure/signed-url.get.js";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
import { draftTreeScenario } from "../../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { drizzleFileAccess } from "../../../test-support/file-grants.js";
import { createInMemoryCollabDomain, createLinkScopeObserver } from "../../collab/index.js";
import { createDrizzleFileFacts } from "../../file-policy/adapters/drizzle-file-facts.js";
import { createOwnerFileGrants } from "../../file-policy/adapters/owner-file-grants.js";
import { createFileAccess } from "../../file-policy/file-access.js";
import { createNoopEventSink } from "../../observability/index.js";
import {
  createProjectBootstrapRepositoryForTest,
  createProjectRepositoryForTest,
} from "../../projects/test-support/project-repository.js";
import { createDrizzleRecentDocumentsRepository } from "../../recent-documents/adapters/drizzle/recent-documents-repository.js";
import { RecentDocumentUnavailableError } from "../../recent-documents/ports/recent-documents-repository.js";
import { createInMemoryObjectStore } from "../../storage/index.js";
import { createDrizzleThreadRepository } from "../../threads/adapters/drizzle/thread-repository.js";
import { createDrizzleThreadWorksRepository } from "../../threads/adapters/drizzle/thread-works-repository.js";
import { createDrizzleDocumentLinkScopes } from "../adapters/document-link-scope.js";
import { createDrizzleLinkAheadRegistry } from "../adapters/drizzle-link-ahead-registry.js";
import { createDrizzleFigureDocumentRepository } from "../adapters/figures/drizzle-figure-document-repository.js";
import { createDrizzleProjectContextAvailability } from "../adapters/project-context-availability.js";
import { createDocumentRevisions } from "../document-revisions.js";
import { createFigureAssetService } from "../figures/figure-assets.js";
import { countIncomingLinks } from "../links/move-link-count.js";
import { createDrizzleUploadIntakeRepository } from "../uploads/drizzle-upload-intake.js";
import { createDrizzleUploadIdentityPort } from "../uploads/upload-identity.js";
import { createTreeReader, LIVE_TREE } from "./tree-view.js";

const url = process.env.DATABASE_URL;
if (process.env.RUN_DB_TESTS !== "1" || !url) {
  describe.skip("independent reader chokepoints", () => {});
} else {
  assertThrowawayDatabaseForRunDbTests(url);
  describe("independent reader chokepoints", () => {
    // Registry registration owns a root transaction, so scenarios must be committed.
    const db = createDb(url, { max: 8 });
    beforeEach(() => deleteDrizzleRows(db, [users]));
    afterAll(async () => {
      await deleteDrizzleRows(db, [users]);
      await db.close();
    });
    const runtimes = useComposedRuntimes(() => db);

    const HARBOR = "lore/places/harbor.md";
    const HARBOR_TEXT = "The harbor smells of salt and tar.";

    /** A model's create in its draft, with text: hidden folders, a hidden row, D's branch. */
    async function modelHarbor() {
      const runtime = await runtimes.compose();
      const scenario = await draftTreeScenario(db, { runtime, runtimes });
      const ascension = await scenario.work("Ascension", "draft");
      const harbor = await scenario.model(ascension).create(HARBOR, HARBOR_TEXT);
      const scope = { kind: "project", projectId: scenario.project.id } as const;
      return { runtime, scenario, ascension, harbor, scope };
    }
    async function setup() {
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

    async function fixture() {
      const scenario = await draftTreeScenario(db);
      const work = await scenario.work("Draft", "draft");
      const direct = await scenario.work("Direct", "direct");
      const hidden = await scenario.seedHidden(work, "lore/kael.md");
      const target = await scenario.seedLive("chapter.md");
      const tree = createTreeReader(db);
      const fileAccess = createFileAccess({
        facts: createDrizzleFileFacts(db),
        grants: createOwnerFileGrants(),
        readAgentChain: async () => [],
      });
      const scopes = createDrizzleDocumentLinkScopes({
        db,
        fileAccess,
        drafts: scenario.drafts,
        observer: createLinkScopeObserver(),
      });
      const revisions = createDocumentRevisions({
        links: scopes,
        documents: { readEffectiveRevision: async () => "draft-revision" },
        drafts: scenario.drafts,
        availability: createDrizzleProjectContextAvailability(db),
        threads: createDrizzleThreadRepository(db),
        threadWorks: createDrizzleThreadWorksRepository(db),
        works: {
          findById: async (id) =>
            ({
              ...[work, direct].find((w) => w.id === id),
              aiWriteMode: id === work.id ? "draft" : "direct",
              deletedAt: null,
              isNoWork: false,
            }) as never,
        },
      });
      async function link(view: LinkView) {
        const aheadId = randomUUID();
        await db.insert(linkAheadRefs).values({
          aheadId,
          projectId: scenario.project.id,
          scheme: "manuscript",
          path: "lore/kael.md",
        });
        return scopes.within(
          { projectId: scenario.project.id, viewer: { accountId: scenario.project.userId } },
          async () => {
            await scopes.prepare({
              holders: [],
              views: [view],
              refs: [`doc:${hidden}`, `ahead:${aheadId}`],
              addresses: ["manuscript://lore/kael.md"],
            });
            const scope = scopes.reader({ uri: null, view });
            return {
              identity: scope.resolve({ ref: `doc:${hidden}`, href: "lore/kael.md" }),
              occupant: scope.resolve({
                ref: `ahead:${aheadId}`,
                href: "manuscript://lore/kael.md",
              }),
            };
          },
        );
      }
      return { scenario, work, direct, hidden, target, tree, scopes, revisions, link, fileAccess };
    }

    it("keeps hidden documents out of independent live readers (C-1a)", async () => {
      const s = await setup();
      // A stale recent is pruned when a different live document is recorded.
      await s.db.insert(userRecentDocuments).values({ userId: s.actor.userId, documentId: s.id });
      const live = await s.scenario.seedLive("chapter.md");
      const f = await fixture();
      await db.insert(documentLinks).values({
        sourceDocumentId: f.hidden,
        targetDocumentId: f.target,
        linkKey: `doc:${f.target}`,
        address: "manuscript://chapter.md",
        occurrences: 2,
      });
      const pending = randomUUID();
      await db.insert(documentLinks).values({
        sourceDocumentId: f.hidden,
        aheadId: pending,
        linkKey: `ahead:${pending}`,
        address: "manuscript://future.md",
        occurrences: 1,
      });
      const aheadId = randomUUID();
      const registry = createDrizzleLinkAheadRegistry(db);
      const m = await modelHarbor();
      const liveFs = m.scenario.view("live");
      const rows = [
        {
          surface: "catalog snapshot",
          run: async () =>
            (await m.runtime.ports.contextCatalog.snapshot(m.scope)).entries.some(
              (entry) => entry.entryId === m.harbor,
            ),
          expected: false,
        },
        {
          surface: "catalog snapshot hidden folders",
          run: async () =>
            (await m.runtime.ports.contextCatalog.snapshot(m.scope)).entries.flatMap((entry) =>
              entry.kind === "folder" && ["lore", "places"].includes(entry.name)
                ? [entry.name]
                : [],
            ),
          expected: [],
        },
        {
          surface: "catalog children",
          run: async () =>
            (
              await m.runtime.ports.contextCatalog.children({
                scope: m.scope,
                parentId: m.scenario.project.sources.manuscript,
              })
            ).entries.some((entry) => entry.name === "lore"),
          expected: false,
        },
        {
          surface: "ContextFS stat",
          run: async () => {
            const stat = await liveFs.stat(HARBOR);
            return stat.ok ? stat.value.documentId : stat.error.code;
          },
          expected: "not_found",
        },
        {
          surface: "ContextFS ls",
          run: async () => {
            const listing = await liveFs.ls("manuscript://");
            return listing.ok
              ? listing.value.entries.some((entry) => entry.uri === "manuscript://lore")
              : listing.error.code;
          },
          expected: false,
        },
        {
          surface: "ContextFS read",
          run: async () => {
            const read = await liveFs.read(HARBOR);
            return read.ok ? read.value.documentId : read.error.code;
          },
          expected: "not_found",
        },
        {
          surface: "ContextFS search",
          run: async () => {
            const hits = await liveFs.search("smells of salt");
            return hits.ok
              ? hits.value.some((hit) => hit.documentId === m.harbor)
              : hits.error.code;
          },
          expected: false,
        },
        {
          surface: "ContextFS locate",
          run: () => liveFs.locate(m.harbor),
          expected: null,
        },
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
        {
          surface: "live room admission",
          run: () => hasLiveDocument(f.tree, f.hidden),
          expected: false,
        },
        {
          surface: "download",
          run: async () => {
            try {
              await downloadDocument(
                {
                  liveDocuments: f.tree,
                  uploadIdentity: {} as never,
                  objectStore: {} as never,
                  documentSync: {} as never,
                },
                f.hidden,
                {} as never,
              );
              return null;
            } catch (cause) {
              return (cause as { statusCode?: number }).statusCode;
            }
          },
          expected: 404,
        },
        {
          surface: "live revision",
          run: async () =>
            (
              await f.revisions.current({ threadId: f.direct.threadId, documentIds: [f.hidden] })
            ).get(f.hidden),
          expected: null,
        },
        {
          surface: "move link holder",
          run: () =>
            countIncomingLinks(db, {
              projectId: f.scenario.project.id,
              movedDocumentIds: [f.target],
            }),
          expected: { links: 0, documents: 0 },
        },
        {
          surface: "ahead-ref live settlement",
          run: async () => {
            await registry.register([
              {
                aheadId,
                holderProjectId: f.scenario.project.id,
                address: "manuscript://lore/kael.md",
              },
            ]);
            await registry.settleArrivals([f.hidden]);
            const [ahead] = await db
              .select()
              .from(linkAheadRefs)
              .where(eq(linkAheadRefs.aheadId, aheadId));
            return ahead?.settledDocumentId;
          },
          expected: null,
        },
        {
          surface: "ahead-ref recovery ignores hidden holders",
          run: async () =>
            (await registry.registerUnregistered({ documentId: f.hidden }, { limit: 10 }))
              .registered,
          expected: 0,
        },
        {
          surface: "link scope by id",
          run: async () => {
            const { identity } = await f.link({ kind: "live" });
            return identity.kind === "document" && identity.inDraft;
          },
          expected: true,
        },
        {
          surface: "hidden address occupancy",
          run: async () => (await f.link({ kind: "live" })).occupant.kind === "document",
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
      const f = await fixture();
      const draft = await f.scenario.draftOf(f.work);
      const m = await modelHarbor();
      const draftFs = m.scenario.view(m.ascension);
      const rows = [
        {
          surface: "ContextFS stat in D",
          run: async () => {
            const stat = await draftFs.stat(HARBOR);
            return stat.ok ? stat.value.documentId : stat.error.code;
          },
          expected: m.harbor,
        },
        {
          surface: "ContextFS ls in D",
          run: async () => {
            const listing = await draftFs.ls("lore/places");
            return listing.ok
              ? listing.value.entries.map((entry) => [entry.uri, entry.documentId])
              : listing.error.code;
          },
          expected: [[`manuscript://${HARBOR}`, m.harbor]],
        },
        {
          surface: "ContextFS read in D",
          run: async () => {
            const read = await draftFs.read(HARBOR);
            return read.ok
              ? [read.value.documentId, read.value.content.includes(HARBOR_TEXT)]
              : read.error.code;
          },
          expected: [m.harbor, true],
        },
        {
          surface: "ContextFS search in D",
          run: async () => {
            const hits = await draftFs.search("smells of salt");
            return hits.ok
              ? hits.value.flatMap((hit) => (hit.documentId === m.harbor ? [hit.uri] : []))
              : hits.error.code;
          },
          expected: [`manuscript://${HARBOR}`],
        },
        {
          surface: "ContextFS locate in D",
          run: () => draftFs.locate(m.harbor),
          expected: { path: HARBOR },
        },
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
        {
          surface: "draft link scope",
          run: async () => {
            const { identity } = await f.link({ kind: "draft", workId: f.work.id });
            return identity.kind === "document" && identity.inDraft;
          },
          expected: true,
        },
        {
          surface: "draft revision",
          run: async () =>
            (await f.revisions.current({ threadId: f.work.threadId, documentIds: [f.hidden] })).get(
              f.hidden,
            ),
          expected: "draft-revision",
        },
        {
          surface: "draft-view file access",
          run: async () =>
            (
              await f.fileAccess.listAccess({ accountId: f.scenario.project.userId }, [f.hidden], {
                draftViews: new Map([[f.hidden, { kind: "draft", draftId: draft.id }]]),
              })
            ).has(f.hidden),
          expected: true,
        },
        {
          surface: "still hidden live",
          run: async () => (await f.tree.findById(LIVE_TREE, f.hidden)).kind,
          expected: "not_found",
        },
        {
          surface: "discarded draft create revision",
          run: async () => {
            // The Discard kernel's persisted end state: a tombstone, no draft use.
            await db
              .update(documents)
              .set({ deletedAt: new Date() })
              .where(eq(documents.id, f.hidden));
            await db.delete(draftTreeChanges).where(eq(draftTreeChanges.nodeId, f.hidden));
            return (
              await f.revisions.current({ threadId: f.work.threadId, documentIds: [f.hidden] })
            ).get(f.hidden);
          },
          expected: null,
        },
      ];
      for (const row of rows) expect.soft(await row.run(), row.surface).toEqual(row.expected);
    });
  });
}
