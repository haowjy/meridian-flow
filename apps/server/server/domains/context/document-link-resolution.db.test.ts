/** Real catalog/Work-authority integration for canonical document-link navigation. */
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  linkAheadRefs,
  projects,
  threads,
  threadWorks,
  users,
  works,
} from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type DocumentLinkRouteDeps,
  handleDocumentLinkResolveRequest,
} from "../../lib/document-link-route.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../test-support/drizzle-reset.js";
import { createLinkScopeObserver } from "../collab/index.js";
import { createNoopEventSink } from "../observability/index.js";
import { createDrizzleProjectWorkAuthorityResolver } from "../projects/index.js";
import { createDrizzleContextCatalog } from "./adapters/context-catalog.js";
import { DrizzleContextTreeMutationStore } from "./adapters/context-fs/drizzle-tree-mutation-store.js";
import { createDrizzleDocumentLinkHistory } from "./adapters/document-link-history.js";
import { createDrizzleDocumentLinkScopes } from "./adapters/document-link-scope.js";
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
    it("reads No Work's manifest when its lineage root has rebound to another Work", async () => {
      const db = database.current;
      const root = crypto.randomUUID();
      const fork = crypto.randomUUID();
      await db.insert(threads).values([
        { id: root, projectId: p, rootThreadId: root, createdByUserId: u, ref: "c1" },
        { id: fork, projectId: p, rootThreadId: root, createdByUserId: u, ref: "c2" },
      ]);
      await db.insert(threadWorks).values([
        { threadId: root, projectId: p, workId: a, isPrimary: true },
        { threadId: fork, projectId: p, workId: noWork, isPrimary: true },
      ]);
      const source = crypto.randomUUID();
      const namedOnly = crypto.randomUUID();
      const noWorkOnly = crypto.randomUUID();
      await db.insert(contextSources).values({
        id: source,
        projectId: p,
        scope: "project",
        slug: "manuscript",
        name: "Manuscript",
      });
      await db.insert(documents).values([
        { id: namedOnly, contextSourceId: source, name: "named", extension: "md" },
        { id: noWorkOnly, contextSourceId: source, name: "no-work", extension: "md" },
      ]);
      const { createHarness } = await import(
        "../collab/test-support/change-trail-postgres-harness.js"
      );
      const { createTestDocumentLinkScopes } = await import(
        "../collab/test-support/document-link-scopes.js"
      );
      const harness = createHarness(db, { links: createTestDocumentLinkScopes(db) });
      try {
        const branches = harness.crossWorkProbeFixture().branchStore;
        await branches.recordManifestDocumentCreated(namedOnly, { projectId: p, workId: a });
        await branches.recordManifestDocumentCreated(noWorkOnly, { projectId: p, workId: noWork });
        const fileAccess: DocumentLinkRouteDeps["fileAccess"] = {
          listAccess: async (_principal, ids) => new Map(ids.map((id) => [id, {} as never])),
        };
        const deps: DocumentLinkRouteDeps = {
          projectRepo: { findById: async () => ({ userId: u, deletedAt: null }) } as never,
          documentLinks: resolver(),
          fileAccess,
          workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
          linkScopes: createDrizzleDocumentLinkScopes({
            db,
            fileAccess,
            membership: (view) => branches.resolveManifestMembership(view),
            observer: createLinkScopeObserver(createNoopEventSink()),
          }),
        };
        const links = [
          { ref: `doc:${namedOnly}`, href: "manuscript://named.md" },
          { ref: `doc:${noWorkOnly}`, href: "manuscript://no-work.md" },
        ];
        for (const baseUri of [null, "scratch://@/c1/holder.md"]) {
          const response = await handleDocumentLinkResolveRequest(deps, {
            projectId: p,
            userId: u as never,
            request: { rootThreadId: root, baseUri, links },
          });
          expect(response.answers).toMatchObject([
            { state: "gone" },
            { state: "document", document: { id: noWorkOnly }, inDraft: true },
          ]);
        }
      } finally {
        harness.cancelScheduledPulls();
        harness.destroyWarmState();
      }
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
    it("chat history follows a rename, a document link never does, and a new occupant wins", async () => {
      const db = database.current;
      const targetId = await add("manuscript", "old");
      const [target] = await db.select().from(documents).where(eq(documents.id, targetId));
      if (!target) throw new Error("target fixture missing");
      const tree = new DrizzleContextTreeMutationStore(db);
      const source = await tree.inspect(target.contextSourceId, "old.md");
      if (source?.kind !== "file") throw new Error("source fixture missing");
      expect(
        await tree.commitMove({
          source,
          destinationSourceId: target.contextSourceId,
          destinationPath: "new.md",
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
      const chat = { ...input, previousLocations: true };
      expect(await r.resolve(chat)).toMatchObject({
        documentId: targetId,
        uri: "manuscript://new.md",
      });
      expect(await r.resolve(input)).toBeNull();
      const occupant = crypto.randomUUID();
      await db.insert(documents).values({
        id: occupant,
        contextSourceId: target.contextSourceId,
        name: "old",
        extension: "md",
      });
      expect(await r.resolve(chat)).toMatchObject({ documentId: occupant });
      expect(await r.resolve(input)).toMatchObject({ documentId: occupant });
    });

    it("answers ref links through the route core: gone never carries a location", async () => {
      const db = database.current;
      const live = await add("manuscript", "live");
      const [{ contextSourceId } = { contextSourceId: "" }] = await db
        .select({ contextSourceId: documents.contextSourceId })
        .from(documents)
        .where(eq(documents.id, live));
      const sibling = async (name: string) => {
        const id = crypto.randomUUID();
        await db.insert(documents).values({ id, contextSourceId, name, extension: "md" });
        return id;
      };
      const deleted = await sibling("deleted");
      const discarded = await sibling("discarded");
      const secret = await sibling("secret");
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, deleted));
      const otherProject = crypto.randomUUID();
      const otherSource = crypto.randomUUID();
      const foreign = crypto.randomUUID();
      await db
        .insert(projects)
        .values({ id: otherProject, userId: u, name: "Other", slug: "other-project" });
      await db.insert(contextSources).values({
        id: otherSource,
        projectId: otherProject,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
      });
      await db
        .insert(documents)
        .values({ id: foreign, contextSourceId: otherSource, name: "foreign", extension: "md" });
      const settled = crypto.randomUUID();
      const unsettled = crypto.randomUUID();
      const settledGone = crypto.randomUUID();
      const occupied = crypto.randomUUID();
      await db.insert(linkAheadRefs).values([
        {
          aheadId: settledGone,
          projectId: p,
          scheme: "manuscript",
          path: "deleted.md",
          settledDocumentId: deleted,
        },
        // Rule 4: unsettled, answered by the document at its exact address.
        { aheadId: occupied, projectId: p, scheme: "manuscript", path: "live.md" },
        {
          aheadId: settled,
          projectId: p,
          scheme: "manuscript",
          path: "live.md",
          settledDocumentId: live,
        },
        { aheadId: unsettled, projectId: p, scheme: "manuscript", path: "later.md" },
      ]);
      // A discarded draft creation keeps its row but no manifest lists it.
      const liveMembers = [live, deleted, secret];
      const provisioned: unknown[] = [];
      const deps: DocumentLinkRouteDeps = {
        projectRepo: { findById: async () => ({ userId: u, deletedAt: null }) } as never,
        documentLinks: resolver(),
        linkScopes: createDrizzleDocumentLinkScopes({
          db,
          fileAccess: {
            async listAccess(_principal, ids) {
              return new Map(ids.filter((id) => id !== secret).map((id) => [id, {} as never]));
            },
          },
          membership: async (view) => {
            provisioned.push(view);
            return { members: view.workId === noWork ? [...liveMembers, discarded] : liveMembers };
          },
          observer: createLinkScopeObserver(createNoopEventSink()),
        }),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        fileAccess: {
          async listAccess(_principal, ids) {
            return new Map(ids.map((id) => [id, {} as never]));
          },
        },
      };
      const response = await handleDocumentLinkResolveRequest(deps, {
        projectId: p,
        userId: u as never,
        request: {
          baseUri: "manuscript://holder.md",
          links: [
            { ref: `doc:${live}`, href: "manuscript://old-live.md" },
            { ref: `doc:${deleted}`, href: "manuscript://deleted.md" },
            { ref: `doc:${discarded}`, href: "manuscript://discarded.md" },
            { ref: `doc:${secret}`, href: "manuscript://secret.md" },
            { ref: `doc:${foreign}`, href: "manuscript://foreign.md" },
            { ref: `ahead:${settled}`, href: "manuscript://elsewhere.md" },
            { ref: `ahead:${unsettled}`, href: "manuscript://later.md#scene" },
            { ref: `ahead:${settledGone}`, href: "manuscript://deleted.md" },
            { ref: `ahead:${occupied}`, href: "manuscript://live.md" },
            { ref: "doc:not-a-uuid", href: "manuscript://live.md" },
            { ref: null, href: "live.md" },
            { ref: null, href: "https://example.com" },
          ],
        },
      });
      const liveDocument = {
        state: "document",
        document: { id: live, title: "live", scheme: "manuscript", path: "live.md" },
        inDraft: false,
      };
      expect(response.answers).toMatchObject([
        liveDocument,
        { state: "gone" },
        { state: "gone" },
        { state: "gone" },
        { state: "gone" },
        liveDocument,
        { state: "missing", uri: "manuscript://later.md" },
        { state: "gone" },
        liveDocument,
        { state: "gone" },
        liveDocument,
        { state: "unresolvable" },
      ]);
      // Only rule 3 marks an answer settled; a rule-4 occupant is still by address.
      expect(response.answers.map((answer) => "settled" in answer)).toEqual([
        false,
        false,
        false,
        false,
        false,
        true,
        false,
        true,
        false,
        false,
        false,
        false,
      ]);
      for (const answer of response.answers)
        if (answer.state === "gone")
          expect(Object.keys(answer).filter((key) => key !== "settled")).toEqual(["state"]);
      // A chat's lineage Scratch owner must not erase its No Work draft view.
      const root = crypto.randomUUID();
      await db
        .insert(threads)
        .values({ id: root, projectId: p, rootThreadId: root, createdByUserId: u, ref: "c1" });
      const noWorkDraft = await handleDocumentLinkResolveRequest(deps, {
        projectId: p,
        userId: u as never,
        request: {
          rootThreadId: root,
          baseUri: null,
          links: [{ ref: `doc:${discarded}`, href: "manuscript://discarded.md" }],
        },
      });
      expect(noWorkDraft.answers).toMatchObject([
        { state: "document", document: { id: discarded }, inDraft: true },
      ]);
      // A Work of another project never reaches draft membership provisioning.
      const foreignWork = crypto.randomUUID();
      await db.insert(works).values({
        id: foreignWork,
        projectId: otherProject,
        createdByUserId: u,
        name: "Foreign",
        slug: "foreign",
      });
      provisioned.length = 0;
      await expect
        .soft(
          handleDocumentLinkResolveRequest(deps, {
            projectId: p,
            userId: u as never,
            request: {
              baseUri: null,
              workId: foreignWork,
              links: [{ ref: `doc:${live}`, href: "manuscript://live.md" }],
            },
          }),
        )
        .rejects.toMatchObject({ statusCode: 404 });
      expect.soft(provisioned).toEqual([]);
    });
  });
}
