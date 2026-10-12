/**
 * The hidden-node reader chokepoints (contract §16.3, F15): a draft's hidden document is
 * absent from every live surface (C-1a) and present in its draft's view (C-1b). One
 * subject, built through the product path, is read by every row of each table with
 * `expect.soft`, so a failure names every leaking surface. Rows only read; the probes
 * that must write (recording a recent, reserving an upload name, a bootstrap) are their
 * own cases. Collaborators come from the composed runtime.
 */

import { randomUUID } from "node:crypto";
import type { DocumentId, LinkView } from "@meridian/contracts";
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
import { and, eq, inArray } from "drizzle-orm";
import { createApp, defineEventHandler, getRouterParam, toWebHandler } from "nitro/h3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadDocument } from "../../../lib/document-download-route.js";
import { hasLiveDocument } from "../../../lib/yjs-ws-handler.js";
import { createFigureSignedUrlHandler } from "../../../routes/api/projects/[projectId]/documents/[documentId]/figure/signed-url.get.js";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
import { draftTreeScenario } from "../../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createDrizzleFileFacts } from "../../file-policy/adapters/drizzle-file-facts.js";
import { RecentDocumentUnavailableError } from "../../recent-documents/ports/recent-documents-repository.js";
import { createDrizzleFigureDocumentRepository } from "../adapters/figures/drizzle-figure-document-repository.js";
import { createDocumentRevisions } from "../document-revisions.js";
import { countIncomingLinks } from "../links/move-link-count.js";
import { createDrizzleUploadIntakeRepository } from "../uploads/drizzle-upload-intake.js";
import { LIVE_TREE } from "./tree-view.js";

const url = process.env.DATABASE_URL;
if (process.env.RUN_DB_TESTS !== "1" || !url) {
  describe.skip("hidden-node reader chokepoints", () => {});
} else {
  assertThrowawayDatabaseForRunDbTests(url);
  describe("hidden-node reader chokepoints", () => {
    // Registry registration owns a root transaction, so scenarios must be committed.
    const db = createDb(url, { max: 8 });
    beforeEach(() => deleteDrizzleRows(db, [users]));
    afterAll(async () => {
      await deleteDrizzleRows(db, [users]);
      await db.close();
    });
    const runtimes = useComposedRuntimes(() => db);

    const HARBOR = "lore/places/harbor.md";
    const HARBOR_URI = `manuscript://${HARBOR}`;
    const HARBOR_TEXT = "The harbor smells of salt and tar.";
    const MAP = "atlas/map.png";

    /**
     * One subject through the product path: Ascension's draft creates harbor with text,
     * copies a live chart in as its own hidden picture, and discards a create. States the
     * product can't reach yet are seeded on the draft's other creates: tombstones the
     * draft still names, a create the draft moved, a hidden holder's link rows, a recent.
     */
    async function subject() {
      const runtime = await runtimes.compose();
      const { ports, app } = runtime;
      const scenario = await draftTreeScenario(db, { runtime, runtimes });
      const { id: projectId, userId } = scenario.project;
      const ascension = await scenario.work("Ascension", "draft");
      const direct = await scenario.work("Direct", "direct");
      const model = scenario.model(ascension);
      const written = await scenario.writer.create("chapter.md", { content: "Chapter one." });
      const chapter = written.documentId as DocumentId;

      const harbor = await model.create(HARBOR, HARBOR_TEXT);
      const chart = new Uint8Array([137, 80, 78, 71]);
      const put = await ports.objectStore.put(`uploads/${projectId}/chart`, chart, "image/png");
      if (!put.ok) throw new Error(put.error.message);
      const uploaded = await ports.contextPorts
        .forProject(projectId, userId, new Map())
        .writeBinary("manuscript://charts/chart.png", {
          fileType: "image",
          storageUrl: put.value.storageUrl,
          mimeType: "image/png",
          sizeBytes: chart.byteLength,
        });
      if (!uploaded.ok) throw new Error(JSON.stringify(uploaded.error));
      await model.copy("charts/chart.png", MAP);
      const mapStat = await scenario.view(ascension).stat(MAP);
      if (!mapStat.ok || !mapStat.value.documentId) throw new Error("The copy left no picture");
      const map = mapStat.value.documentId as DocumentId;
      const [mapRow] = await db
        .select({ storageUrl: documents.storageUrl })
        .from(documents)
        .where(eq(documents.id, map));
      const discarded = await model.create("discarded.md", "Discarded.");
      await scenario.discard(ascension, [discarded]);

      // Tombstones the draft still names (stale change rows).
      const tombstones = [
        await model.create("gone.md", "Gone."),
        await model.create("retired/gone.md", "Retired."),
      ];
      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(inArray(documents.id, tombstones));
      // A draft's move of its create (PR 3): the row stays, the draft has it elsewhere.
      const draft = await scenario.draftOf(ascension);
      const relocated = await model.create("secret/relocated.md", "Relocated.");
      const anchor = await model.create("draft-location/anchor.md", "Anchor.");
      const [anchorRow] = await db
        .select({ folderId: documents.folderId })
        .from(documents)
        .where(eq(documents.id, anchor));
      if (!anchorRow?.folderId) throw new Error("Missing the draft's folder");
      await db
        .update(draftTreeChanges)
        .set({ parentFolderId: anchorRow.folderId })
        .where(and(eq(draftTreeChanges.draftId, draft.id), eq(draftTreeChanges.nodeId, relocated)));
      // Link rows a hidden holder never derives, and a recent it can't record.
      const pending = randomUUID();
      await db.insert(documentLinks).values([
        {
          sourceDocumentId: harbor,
          targetDocumentId: chapter,
          linkKey: `doc:${chapter}`,
          address: "manuscript://chapter.md",
          occurrences: 2,
        },
        {
          sourceDocumentId: harbor,
          aheadId: pending,
          linkKey: `ahead:${pending}`,
          address: "manuscript://future.md",
          occurrences: 1,
        },
      ]);
      await db.insert(userRecentDocuments).values({ userId, documentId: harbor });

      // A live ref at harbor's address and an arrival of harbor, which must not settle
      // it; and an editor's mint in D's text, registered in D.
      const liveRef = randomUUID();
      const draftRef = randomUUID();
      await ports.linkAheadRegistry.register([
        { aheadId: liveRef, holderProjectId: projectId, address: HARBOR_URI },
        { aheadId: draftRef, holderProjectId: projectId, address: HARBOR_URI, draftId: draft.id },
      ]);
      await ports.linkAheadRegistry.settleArrivals([harbor]);

      // For the picture's denials: a rival Work's draft and another account's Work.
      const rival = await scenario.work("Rival", "draft");
      await scenario.model(rival).create("rival.md", "The rival's.");
      const foreign = await draftTreeScenario(db, { runtime, runtimes });
      const foreignWork = await foreign.work("Foreign", "draft");
      await foreign.model(foreignWork).create("foreign.md", "Foreign.");

      const signing = vi.spyOn(ports.objectStore, "getSignedUrl");
      /** The figure route, as the writer (or another account) calls it, and what it signed. */
      async function figure(workId?: string, principal = userId) {
        const route = createApp();
        route.get(
          "/api/projects/:projectId/documents/:documentId/figure/signed-url",
          createFigureSignedUrlHandler(async () => ({ app: ports, user: { userId: principal } })),
        );
        const query = workId === undefined ? "" : `?workId=${workId}`;
        const before = signing.mock.calls.length;
        const response = await toWebHandler(route)(
          new Request(
            `https://server.local/api/projects/${projectId}/documents/${map}/figure/signed-url${query}`,
          ),
        );
        return {
          status: response.status,
          body: await response.json(),
          signed: signing.mock.calls.length - before,
        };
      }
      /** The download route's status for a document. */
      async function download(documentId: DocumentId) {
        const route = createApp();
        route.get(
          "/download/:documentId",
          defineEventHandler((event) =>
            downloadDocument(app, getRouterParam(event, "documentId") ?? "", event),
          ),
        );
        const response = await toWebHandler(route)(
          new Request(`https://server.local/download/${documentId}`),
        );
        return response.status;
      }
      /** The link scope's answers, in `view`, for harbor by id and for a ref at its address. */
      function link(view: LinkView, aheadId: string) {
        const scopes = ports.linkScopes;
        return scopes.within({ projectId, viewer: { accountId: userId } }, async () => {
          await scopes.prepare({
            holders: [],
            views: [view],
            refs: [`doc:${harbor}`, `ahead:${aheadId}`],
            addresses: [HARBOR_URI],
          });
          const scope = scopes.reader({ uri: null, view });
          return {
            identity: scope.resolve({ ref: `doc:${harbor}`, href: HARBOR }),
            occupant: scope.resolve({ ref: `ahead:${aheadId}`, href: HARBOR_URI }),
          };
        });
      }
      return {
        runtime,
        scenario,
        projectId,
        userId,
        ascension,
        direct,
        draft,
        chapter,
        harbor,
        map,
        mapStorageUrl: mapRow?.storageUrl,
        discarded,
        tombstones,
        relocated,
        relocatedFolder: anchorRow.folderId,
        liveRef,
        draftRef,
        rival,
        foreign,
        foreignWork,
        facts: createDrizzleFileFacts(db),
        figures: createDrizzleFigureDocumentRepository({ db }),
        revisions: createDocumentRevisions({
          links: ports.linkScopes,
          threads: ports.threadRepos.threads,
          availability: ports.projectContextAvailability,
          documents: ports.documentSync,
          drafts: ports.documentSync.drafts,
          threadWorks: ports.threadRepos.threadWorks,
          works: ports.workRepo,
        }),
        figure,
        download,
        link,
        scope: { kind: "project", projectId } as const,
      };
    }

    const denied = (message = "Document not found") => ({
      status: 404,
      body: { status: 404, message },
      signed: 0,
    });

    it("keeps hidden documents out of independent live readers (C-1a)", async () => {
      const s = await subject();
      const { ports, app } = s.runtime;
      const liveFs = s.scenario.view("live");
      const input = { projectId: s.projectId, documentIds: [s.harbor] };
      const actor = { userId: s.userId };
      const rows = [
        {
          surface: "catalog snapshot",
          run: async () =>
            (await ports.contextCatalog.snapshot(s.scope)).entries.some(
              (entry) => entry.entryId === s.harbor,
            ),
          expected: false,
        },
        {
          surface: "catalog snapshot hidden folders",
          run: async () =>
            (await ports.contextCatalog.snapshot(s.scope)).entries.flatMap((entry) =>
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
              await ports.contextCatalog.children({
                scope: s.scope,
                parentId: s.scenario.project.sources.manuscript,
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
              ? hits.value.some((hit) => hit.documentId === s.harbor)
              : hits.error.code;
          },
          expected: false,
        },
        { surface: "ContextFS locate", run: () => liveFs.locate(s.harbor), expected: null },
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
            (
              await ports.projectContextAvailability.lookup(
                { ...input, documentIds: s.tombstones },
                actor,
              )
            ).resolutions,
          expected: s.tombstones.map((documentId) => ({
            kind: "not-visible",
            documentId,
            checkedGeneration: expect.any(String),
          })),
        },
        {
          surface: "file facts list",
          run: async () => (await s.facts.loadList([s.harbor])).has(s.harbor),
          expected: false,
        },
        {
          surface: "upload identity batch",
          run: async () => (await ports.uploadIdentity.lookupDocuments([s.harbor])).length,
          expected: 0,
        },
        {
          surface: "figure host identity",
          run: () => s.figures.documentExistsForProject(s.projectId, s.harbor),
          expected: false,
        },
        {
          surface: "file facts",
          run: () => s.facts.load({ target: { kind: "document", documentId: s.harbor } }),
          expected: null,
        },
        {
          surface: "availability",
          run: async () =>
            (await ports.projectContextAvailability.lookup(input, actor)).resolutions[0],
          expected: {
            kind: "not-visible",
            documentId: s.harbor,
            checkedGeneration: expect.any(String),
          },
        },
        { surface: "figure signed URL without workId", run: () => s.figure(), expected: denied() },
        {
          surface: "upload identity",
          run: () => ports.uploadIdentity.lookupDocument(s.harbor),
          expected: null,
        },
        {
          surface: "recents record",
          run: async () => {
            try {
              await ports.recentDocuments.record(s.userId, s.harbor);
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
            (await ports.recentDocuments.listForProject(s.projectId, s.userId)).some(
              (item) => item.documentId === s.harbor,
            ),
          expected: false,
        },
        {
          surface: "live room admission",
          run: () => hasLiveDocument(app.liveDocuments, s.harbor),
          expected: false,
        },
        { surface: "download", run: () => s.download(s.harbor), expected: 404 },
        {
          surface: "live revision",
          run: async () =>
            (
              await s.revisions.current({ threadId: s.direct.threadId, documentIds: [s.harbor] })
            ).get(s.harbor),
          expected: null,
        },
        {
          surface: "move link holder",
          run: () =>
            countIncomingLinks(db, { projectId: s.projectId, movedDocumentIds: [s.chapter] }),
          expected: { links: 0, documents: 0 },
        },
        {
          surface: "ahead-ref live settlement",
          run: async () => {
            const [ahead] = await db
              .select({ settled: linkAheadRefs.settledDocumentId })
              .from(linkAheadRefs)
              .where(eq(linkAheadRefs.aheadId, s.liveRef));
            return ahead?.settled;
          },
          expected: null,
        },
        {
          surface: "ahead-ref recovery ignores hidden holders",
          run: async () =>
            (
              await ports.linkAheadRegistry.registerUnregistered(
                { documentId: s.harbor },
                { limit: 10 },
              )
            ).registered,
          expected: 0,
        },
        {
          surface: "link scope by id",
          run: async () => {
            const { identity } = await s.link({ kind: "live" }, s.liveRef);
            return identity.kind === "document"
              ? [identity.inDraft, identity.document.draft, identity.document.uri]
              : identity.kind;
          },
          expected: [true, { draftId: s.draft.id, workId: s.ascension.id }, HARBOR_URI],
        },
        {
          surface: "hidden address occupancy",
          run: async () => (await s.link({ kind: "live" }, s.liveRef)).occupant.kind === "document",
          expected: false,
        },
        {
          surface: "still hidden live",
          run: async () => (await app.liveDocuments.findById(LIVE_TREE, s.harbor)).kind,
          expected: "not_found",
        },
      ];
      for (const row of rows) expect.soft(await row.run(), row.surface).toEqual(row.expected);
    });

    it("reads independent draft-aware surfaces in the creating draft (C-1b)", async () => {
      const s = await subject();
      const { ports } = s.runtime;
      const draftFs = s.scenario.view(s.ascension);
      const view = { kind: "draft", draftId: s.draft.id } as const;
      const input = { projectId: s.projectId, documentIds: [s.relocated], view };
      const actor = { userId: s.userId };
      const rows = [
        {
          surface: "ContextFS stat in D",
          run: async () => {
            const stat = await draftFs.stat(HARBOR);
            return stat.ok ? stat.value.documentId : stat.error.code;
          },
          expected: s.harbor,
        },
        {
          surface: "ContextFS ls in D",
          run: async () => {
            const listing = await draftFs.ls("lore/places");
            return listing.ok
              ? listing.value.entries.map((entry) => [entry.uri, entry.documentId])
              : listing.error.code;
          },
          expected: [[HARBOR_URI, s.harbor]],
        },
        {
          surface: "ContextFS read in D",
          run: async () => {
            const read = await draftFs.read(HARBOR);
            return read.ok
              ? [read.value.documentId, read.value.content.includes(HARBOR_TEXT)]
              : read.error.code;
          },
          expected: [s.harbor, true],
        },
        {
          surface: "ContextFS search in D",
          run: async () => {
            const hits = await draftFs.search("smells of salt");
            return hits.ok
              ? hits.value.flatMap((hit) => (hit.documentId === s.harbor ? [hit.uri] : []))
              : hits.error.code;
          },
          expected: [HARBOR_URI],
        },
        {
          surface: "ContextFS locate in D",
          run: () => draftFs.locate(s.harbor),
          expected: HARBOR_URI,
        },
        {
          surface: "hidden tombstone facts in D",
          run: () =>
            Promise.all(
              s.tombstones.map((documentId) =>
                s.facts.load({
                  target: { kind: "document", documentId },
                  draftWorkId: s.ascension.id,
                }),
              ),
            ),
          expected: [null, null],
        },
        {
          surface: "hidden tombstone facts list in D",
          run: async () => [...(await s.facts.loadList(s.tombstones, s.ascension.id)).keys()],
          expected: [],
        },
        {
          surface: "hidden tombstone availability in D",
          run: async () =>
            (
              await ports.projectContextAvailability.lookup(
                { ...input, documentIds: s.tombstones },
                actor,
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
          run: async () => (await s.facts.loadList([s.harbor], s.ascension.id)).has(s.harbor),
          expected: true,
        },
        {
          surface: "file facts in D's folder chain",
          run: async () =>
            (
              await s.facts.load({
                target: { kind: "draft", documentId: s.relocated, workId: s.ascension.id },
              })
            )?.ancestors[0],
          expected: { kind: "folder", id: s.relocatedFolder },
        },
        {
          surface: "availability in D",
          run: async () => {
            const result = (await ports.projectContextAvailability.lookup(input, actor))
              .resolutions[0];
            return result?.kind === "available" ? result.entry.uri : result?.kind;
          },
          expected: "manuscript://draft-location/relocated.md",
        },
        {
          surface: "figure other same-project Work's active draft",
          run: () => s.figure(s.rival.id),
          expected: denied(),
        },
        {
          surface: "figure another project's Work",
          run: () => s.figure(s.foreignWork.id),
          expected: denied(),
        },
        {
          surface: "figure guessed Work",
          run: () => s.figure("00000000-0000-4000-8000-000000009999"),
          expected: denied(),
        },
        {
          surface: "figure foreign principal with creating Work",
          run: () => s.figure(s.ascension.id, s.foreign.project.userId),
          expected: denied("Project not found"),
        },
        {
          surface: "figure signed URL with workId",
          run: () => s.figure(s.ascension.id),
          expected: {
            status: 200,
            body: {
              __meridianTransport: true,
              value: {
                assetDocumentId: s.map,
                storageUrl: s.mapStorageUrl,
                mimeType: "image/png",
                fileType: "image",
                signedUrl: expect.any(String),
                signedUrlExpiresAt: expect.any(String),
              },
            },
            signed: 1,
          },
        },
        {
          surface: "draft link scope",
          run: async () => {
            const { identity } = await s.link(view, s.draftRef);
            return identity.kind === "document"
              ? [identity.inDraft, identity.document.draft, identity.document.uri]
              : identity.kind;
          },
          expected: [true, { draftId: s.draft.id, workId: s.ascension.id }, HARBOR_URI],
        },
        {
          surface: "ahead ref in D's text at the path",
          run: async () => {
            const [inDraft, live] = await Promise.all([
              s.link(view, s.draftRef),
              s.link({ kind: "live" }, s.draftRef),
            ]);
            return [
              inDraft.occupant.kind === "document" && [
                inDraft.occupant.document.documentId,
                inDraft.occupant.settled,
              ],
              live.occupant.kind,
            ];
          },
          expected: [[s.harbor, true], "ahead"],
        },
        {
          surface: "draft revision",
          run: async () =>
            (
              await s.revisions.current({
                threadId: s.ascension.threadId,
                documentIds: [s.harbor],
              })
            ).get(s.harbor),
          expected: expect.any(String),
        },
        {
          surface: "draft-view file access",
          run: async () =>
            (
              await ports.fileAccess.listAccess({ accountId: s.userId }, [s.harbor], {
                draftViews: new Map([[s.harbor, view]]),
              })
            ).has(s.harbor),
          expected: true,
        },
        {
          surface: "discarded draft create revision",
          run: async () =>
            (
              await s.revisions.current({
                threadId: s.ascension.threadId,
                documentIds: [s.discarded],
              })
            ).get(s.discarded),
          expected: null,
        },
      ];
      for (const row of rows) expect.soft(await row.run(), row.surface).toEqual(row.expected);
    });

    // The probes that must write, each on its own subject; those that need only a project
    // and a drafting Work skip the full matrix subject.
    async function bareSubject() {
      const runtime = await runtimes.compose();
      const scenario = await draftTreeScenario(db, { runtime, runtimes });
      const ascension = await scenario.work("Ascension", "draft");
      const { id: projectId, userId } = scenario.project;
      return { runtime, scenario, ascension, projectId, userId };
    }

    it("prunes a hidden document's stale recent when a live one is recorded (C-1a)", async () => {
      const s = await subject();
      await s.runtime.ports.recentDocuments.record(s.userId, s.chapter);
      expect(
        await db
          .select()
          .from(userRecentDocuments)
          .where(eq(userRecentDocuments.documentId, s.harbor)),
      ).toEqual([]);
    });

    it("allocates an upload's name past only live documents (C-1a)", async () => {
      const s = await bareSubject();
      // Uploads are never drafted; this adversarial row verifies the live relation.
      const [source] = await db
        .insert(contextSources)
        .values({ workId: s.ascension.id, scope: "work", name: "Uploads", slug: "uploads" })
        .returning();
      if (!source) throw new Error("Missing uploads source");
      const hidden = await s.scenario.seedHidden(s.ascension, "upload.md");
      await db
        .update(documents)
        .set({ contextSourceId: source.id })
        .where(eq(documents.id, hidden));
      const reserved = await createDrizzleUploadIntakeRepository(db).reserve({
        intakeId: "reader-matrix",
        actorUserId: s.userId,
        owner: { kind: "work", projectId: s.projectId, workId: s.ascension.id },
        filename: "upload.md",
        documentFilename: { name: "upload", extension: "", filetype: "markdown" },
        mimeType: "text/markdown",
        byteDigest: "a".repeat(64),
        fingerprint: "reader-matrix",
        fileType: "markdown",
      });
      expect(reserved.kind === "reserved" ? reserved.reservation.finalPath : reserved.kind).toBe(
        "upload",
      );
    });

    it("never bootstraps a hidden chapter as the writer's first chapter (C-1a)", async () => {
      const s = await bareSubject();
      const hidden = await s.scenario.model(s.ascension).create("Chapter 1.md", "Drafted.");
      // The scenario's project stands in for the personal one the world seeded for user://.
      await db
        .update(projects)
        .set({ isPersonal: false })
        .where(eq(projects.id, s.scenario.project.personalId));
      await db.update(projects).set({ isPersonal: true }).where(eq(projects.id, s.projectId));
      const bootstrap = await s.runtime.ports.projects.ensureDefaultBootstrap(s.userId);
      expect(bootstrap.documentId).not.toBe(hidden);
    });
  });
}
