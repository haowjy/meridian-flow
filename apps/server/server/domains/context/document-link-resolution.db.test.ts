/**
 * Real source/Work-authority integration for canonical document-link navigation.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - source-backed canonical navigation under Work-specific readability (kb/wiki/architecture/documents/links.md#following-a-link-is-one-procedure)
 */

import type { DraftOwner } from "@meridian/contracts";
import type { Filetype } from "@meridian/contracts/protocol";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  branches,
  contextSources,
  documents,
  linkAheadRefs,
  projects,
  threads,
  threadWorks,
  users,
  works,
} from "@meridian/database/schema";
import { LIVE, type TreeWriter } from "@meridian/project-tree";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type DocumentLinkRouteDeps,
  handleDocumentLinkResolveRequest,
} from "../../lib/document-link-route.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../test-support/drizzle-reset.js";
import { treeListOfSource, treeSeeder } from "../../test-support/tree-seed.js";
import { createLinkScopeObserver } from "../collab/index.js";
import { createNoopEventSink } from "../observability/index.js";
import { createDrizzleProjectWorkAuthorityResolver } from "../projects/index.js";
import { createDrizzleChatUploadsOwners } from "./adapters/chat-uploads-owners.js";
import { createDrizzleContextSources } from "./adapters/context-sources.js";
import { createDrizzleDocumentLinkHistory } from "./adapters/document-link-history.js";
import { createDrizzleDocumentLinkScopes } from "./adapters/document-link-scope.js";
import { createDocumentLinkResolver } from "./document-link-resolution.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("source-backed document links (postgres)", () => {});
} else {
  describe("source-backed document links (postgres)", () => {
    const u = "00000000-0000-4000-8000-000000000900";
    const p = "00000000-0000-4000-8000-000000000901";
    const personal = "00000000-0000-4000-8000-000000000902";
    const a = "00000000-0000-4000-8000-000000000903";
    const b = "00000000-0000-4000-8000-000000000904";
    const noWork = "00000000-0000-4000-8000-000000000905";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => deleteDrizzleRows(db, [users]),
    });
    const sourceOf = new Map<string, string>();
    /** A document seeded into a source through the list; remembers its source. */
    async function seedDocument(
      sourceId: string,
      name: string,
      options: { id?: string; filetype?: Filetype } = {},
    ) {
      const id = options.id ?? crypto.randomUUID();
      await treeSeeder(database.current).document(sourceId, name, { ...options, id });
      sourceOf.set(id, sourceId);
      return id;
    }
    /** Changes the source's live tree with the writer, as a record any actor could make. */
    async function change(sourceId: string, edit: (writer: TreeWriter) => void) {
      await treeSeeder(database.current).store.submit({
        lists: [await treeListOfSource(database.current, sourceId)],
        make: ([{ writer }]) => {
          edit(writer);
        },
      });
    }
    beforeEach(async () => {
      sourceOf.clear();
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
          handle: null,
          isNoWork: true,
        },
        { id: a, projectId: p, createdByUserId: u, name: "A", handle: "w2" },
        { id: b, projectId: p, createdByUserId: u, name: "B", handle: "w3" },
      ]);
    });
    it("views No Work's branch when its lineage root has rebound to another Work", async () => {
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
      const chapter = crypto.randomUUID();
      await db.insert(contextSources).values({
        id: source,
        projectId: p,
        scope: "project",
        slug: "manuscript",
        name: "Manuscript",
      });
      await seedDocument(source, "chapter", { id: chapter });
      const act = await treeSeeder(db).folder(source, "Act 1");
      const fileAccess: DocumentLinkRouteDeps["fileAccess"] = {
        listAccess: async (_principal, ids) => new Map(ids.map((id) => [id, {} as never])),
      };
      const viewed: (DraftOwner | null)[] = [];
      const deps: DocumentLinkRouteDeps = {
        projectRepo: { findById: async () => ({ userId: u, deletedAt: null }) } as never,
        documentLinks: resolver(),
        fileAccess,
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        linkScopes: createDrizzleDocumentLinkScopes({
          db,
          fileAccess,
          observer: createLinkScopeObserver(createNoopEventSink()),
        }),
        branches: {
          viewForOwner: async (owner) => {
            viewed.push(owner);
            return { kind: "live" };
          },
        },
        files: { lookupDocuments: async () => [] },
        documentTrash: {
          retained: async () => new Set(),
        },
      };
      for (const baseUri of [null, "scratch://@c1/holder"]) {
        viewed.length = 0;
        const response = await handleDocumentLinkResolveRequest(deps, {
          projectId: p,
          userId: u as never,
          request: {
            rootThreadId: root,
            baseUri,
            links: [
              { ref: `doc:${chapter}`, href: "manuscript://chapter" },
              { ref: `folder:${act}`, href: "manuscript://Act%201/" },
              { ref: null, href: "manuscript://Act%201/" },
            ],
          },
        });
        expect(response.answers).toMatchObject([
          { state: "document", document: { id: chapter } },
          { state: "folder", folder: { id: act, name: "Act 1", uri: "manuscript://Act 1" } },
          { state: "folder", folder: { id: act, name: "Act 1", uri: "manuscript://Act 1" } },
        ]);
        // A chat with no Work reads its own lineage's branch view.
        expect(viewed).toEqual([{ kind: "lineage", projectId: p, rootThreadId: root }]);
      }
      await change(source, (writer) => writer.delete(LIVE, "system", act));
      const gone = await handleDocumentLinkResolveRequest(deps, {
        projectId: p,
        userId: u as never,
        request: {
          rootThreadId: root,
          baseUri: null,
          links: [{ ref: `folder:${act}`, href: "manuscript://Act%201/" }],
        },
      });
      expect(gone.answers).toEqual([{ state: "gone" }]);
    });
    function resolver() {
      const db = database.current;
      return createDocumentLinkResolver({
        sources: createDrizzleContextSources(db),
        history: createDrizzleDocumentLinkHistory(db),
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        chats: createDrizzleChatUploadsOwners(db),
      });
    }
    async function add(
      scheme: string,
      name: string,
      workId: string | null = null,
      chatThreadId: string | null = null,
      filetype?: Filetype,
    ) {
      const db = database.current;
      const sourceId = crypto.randomUUID();
      const documentId = crypto.randomUUID();
      await db.insert(contextSources).values({
        id: sourceId,
        slug: scheme,
        name: scheme,
        scope: chatThreadId ? "chat" : workId ? "work" : "project",
        projectId: workId ? null : scheme === "user" ? personal : p,
        workId,
        chatThreadId,
      });
      return seedDocument(sourceId, name, { id: documentId, ...(filetype ? { filetype } : {}) });
    }
    it("opens all canonical schemes, explicit other Work and no-Work targets", async () => {
      const r = resolver();
      for (const [scheme, workId, qualifier] of [
        ["manuscript", null, ""],
        ["kb", null, ""],
        ["unfiled", null, ""],
        ["user", null, ""],
        ["scratch", b, "@w3/"],
      ] as const) {
        const id = await add(scheme, "Gate", workId);
        const uri = `${scheme}://${qualifier}Gate`;
        expect(await r.resolve({ projectId: p, userId: u, workId: a, uri })).toMatchObject({
          documentId: id,
          uri,
          workId,
        });
      }
      // An upload belongs to the chat that received it, spelled by that chat's handle.
      const chatId = crypto.randomUUID();
      await database.current.insert(threads).values({
        id: chatId,
        projectId: p,
        rootThreadId: chatId,
        createdByUserId: u,
        ref: "c9",
      });
      const upload = await add("uploads", "Gate", null, chatId);
      const resolveUpload = (uri: string, chat?: string) =>
        r.resolve({
          projectId: p,
          userId: u,
          workId: a,
          ...(chat ? { chatId: chat } : {}),
          uri,
        });
      expect(await resolveUpload("uploads://@c9/Gate")).toMatchObject({
        documentId: upload,
        uri: "uploads://@c9/Gate",
        chatThreadId: chatId,
      });
      // A bare name means the holder chat's file; a document holder has no chat, so it names nothing.
      expect(await resolveUpload("uploads://Gate", chatId)).toMatchObject({ documentId: upload });
      expect(await resolveUpload("uploads://Gate")).toBeNull();
      // A Work owns no uploads.
      expect(await resolveUpload("uploads://@w3/Gate")).toBeNull();
    });
    it("canonicalizes prose aliases before exact-first non-prose omission", async () => {
      const r = resolver();
      const data = await add("manuscript", "outline.json", null, null, "json");
      const resolve = (path: string) =>
        r.resolve({
          projectId: p,
          userId: u,
          uri: `manuscript://${path}`,
        });
      expect(await resolve("outline")).toMatchObject({
        documentId: data,
        uri: "manuscript://outline.json",
      });
      const prose = crypto.randomUUID();
      const dataSource = sourceOf.get(data);
      if (!dataSource) throw new Error("Missing data fixture");
      await seedDocument(dataSource, "outline", { id: prose });
      for (const path of ["outline", "outline.md", "outline.txt"])
        expect(await resolve(path)).toMatchObject({
          documentId: prose,
          uri: "manuscript://outline",
        });
      expect(await resolve("outline.json")).toMatchObject({ documentId: data });
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
          uri: "scratch://Gate",
        }),
      ).toMatchObject({ documentId: local });
      expect(
        await r.resolve({
          projectId: p,
          userId: u,
          workId: null,
          uri: "scratch://Gate",
        }),
      ).toBeNull();
      await database.current.update(works).set({ archivedAt: new Date() }).where(eq(works.id, b));
      expect(
        await r.resolve({
          projectId: p,
          userId: u,
          workId: a,
          uri: "scratch://@w3/Gate",
        }),
      ).toMatchObject({ scheme: "scratch", path: "Gate" });
      await database.current.update(works).set({ deletedAt: new Date() }).where(eq(works.id, b));
      expect(
        await r.resolve({
          projectId: p,
          userId: u,
          workId: a,
          uri: "scratch://@w3/Gate",
        }),
      ).toBeNull();
      await change(sourceOf.get(local) as string, (writer) => writer.delete(LIVE, "system", local));
      expect(
        await r.resolve({
          projectId: p,
          userId: u,
          workId: a,
          uri: "scratch://Gate",
        }),
      ).toBeNull();
    });
    it("chat history follows a rename, a document link never does, and a new occupant wins", async () => {
      const db = database.current;
      const targetId = await add("manuscript", "old");
      const targetSource = sourceOf.get(targetId) as string;
      await change(targetSource, (writer) => writer.rename(LIVE, "system", targetId, "new"));
      const r = resolver();
      const input = {
        projectId: p,
        userId: u,
        uri: "manuscript://old",
      };
      const chat = { ...input, previousLocations: true };
      expect(await r.resolve(chat)).toMatchObject({
        documentId: targetId,
        uri: "manuscript://new",
      });
      expect(await r.resolve(input)).toBeNull();
      const fileAccess: DocumentLinkRouteDeps["fileAccess"] = {
        listAccess: async (_principal, ids) => new Map(ids.map((id) => [id, {} as never])),
      };
      const deps: DocumentLinkRouteDeps = {
        projectRepo: { findById: async () => ({ userId: u, deletedAt: null }) } as never,
        documentLinks: r,
        fileAccess,
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        linkScopes: createDrizzleDocumentLinkScopes({
          db,
          fileAccess,
          observer: createLinkScopeObserver(createNoopEventSink()),
        }),
        branches: { viewForOwner: async () => ({ kind: "live" }) },
        documentTrash: { retained: async () => new Set() },
        files: { lookupDocuments: async () => [] },
      };
      const routeResolve = (holderDocumentId?: string) =>
        handleDocumentLinkResolveRequest(deps, {
          projectId: p,
          userId: u as never,
          request: {
            baseUri: null,
            ...(holderDocumentId ? { holderDocumentId } : {}),
            links: [{ ref: null, href: "manuscript://old" }],
          },
        });
      expect((await routeResolve()).answers).toMatchObject([
        { state: "document", document: { id: targetId } },
      ]);
      expect((await routeResolve(crypto.randomUUID())).answers).toEqual([
        { state: "missing", uri: "manuscript://old" },
      ]);

      const occupant = crypto.randomUUID();
      await seedDocument(targetSource, "old", { id: occupant });
      expect(await r.resolve(chat)).toMatchObject({ documentId: occupant });
      expect(await r.resolve(input)).toMatchObject({ documentId: occupant });
    });

    it("transports the prepared owners of a mixed catalog without resolving Work handles again", async () => {
      const db = database.current;
      const root = crypto.randomUUID();
      await db.insert(threads).values({
        id: root,
        projectId: p,
        rootThreadId: root,
        createdByUserId: u,
        ref: "c1",
      });
      const lineageSource = crypto.randomUUID();
      const note = crypto.randomUUID();
      await db.insert(contextSources).values({
        id: lineageSource,
        projectId: p,
        rootThreadId: root,
        scope: "lineage",
        slug: "scratch",
        name: "Scratch",
      });
      await seedDocument(lineageSource, "note", { id: note });
      const rows = [
        { id: note, uri: "scratch://@c1/note", workId: null, rootThreadId: root },
        { id: await add("scratch", "named", b), uri: "scratch://@w3/named", workId: b },
        { id: await add("manuscript", "chapter"), uri: "manuscript://chapter", workId: null },
        { id: await add("user", "personal"), uri: "user://personal", workId: null },
      ];
      const fileAccess: DocumentLinkRouteDeps["fileAccess"] = {
        listAccess: async (_principal, ids) => new Map(ids.map((id) => [id, {} as never])),
      };
      const works = createDrizzleProjectWorkAuthorityResolver(db);
      const unexpectedLookup = async () => {
        throw new Error("Prepared document ownership was discarded");
      };
      const deps: DocumentLinkRouteDeps = {
        projectRepo: { findById: async () => ({ userId: u, deletedAt: null }) } as never,
        documentLinks: resolver(),
        fileAccess,
        workAuthorityResolver: { ...works, byHandle: unexpectedLookup, noWork: unexpectedLookup },
        linkScopes: createDrizzleDocumentLinkScopes({
          db,
          fileAccess,
          observer: createLinkScopeObserver(createNoopEventSink()),
        }),
        branches: { viewForOwner: async () => ({ kind: "live" }) },
        documentTrash: { retained: async () => new Set() },
        files: { lookupDocuments: async () => [] },
      };
      const result = await handleDocumentLinkResolveRequest(deps, {
        projectId: p,
        userId: u,
        request: {
          baseUri: null,
          links: rows.map(({ id, uri }) => ({ ref: `doc:${id}`, href: uri })),
        },
      });
      expect(result.answers).toHaveLength(rows.length);
      for (const [index, row] of rows.entries()) {
        expect(result.answers[index]).toMatchObject({ state: "document", document: row });
        if (!("rootThreadId" in row))
          expect(result.answers[index]).not.toHaveProperty("document.rootThreadId");
      }
    });

    it("answers an address-only link from the request's own Work branch, live first", async () => {
      const db = database.current;
      const live = await add("manuscript", "live");
      const contextSourceId = sourceOf.get(live) as string;
      // A document that exists only in a Work's draft.
      const hidden = async (name: string, branchId: string) => {
        const id = crypto.randomUUID();
        await treeSeeder(db).document(contextSourceId, name, { id, view: { draft: branchId } });
        return id;
      };
      const branchA = crypto.randomUUID();
      const branchB = crypto.randomUUID();
      await db.insert(branches).values([
        { id: branchA, projectId: p, originWorkId: a, createdBy: u },
        { id: branchB, projectId: p, originWorkId: b, createdBy: u },
      ]);
      const created = await hidden("created", branchA);
      await hidden("live", branchA);
      await hidden("elsewhere", branchB);
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
          observer: createLinkScopeObserver(createNoopEventSink()),
        }),
        branches: {
          viewForOwner: async (owner) =>
            owner?.kind === "work" && owner.workId === a
              ? { kind: "branch", branchId: branchA }
              : owner?.kind === "work" && owner.workId === b
                ? { kind: "branch", branchId: branchB }
                : { kind: "live" },
        },
        documentTrash: { retained: async () => new Set() },
        files: { lookupDocuments: async () => [] },
      };
      const resolveIn = (workId: string) =>
        handleDocumentLinkResolveRequest(deps, {
          projectId: p,
          userId: u as never,
          request: {
            workId,
            baseUri: null,
            links: ["created", "live", "elsewhere"].map((name) => ({
              ref: null,
              href: `manuscript://${name}`,
            })),
          },
        });
      expect((await resolveIn(a)).answers).toMatchObject([
        {
          state: "document",
          inBranch: true,
          branch: { branchId: branchA },
          document: { id: created },
        },
        { state: "document", inBranch: false, document: { id: live } },
        { state: "missing" },
      ]);
      // Work B's branch created only "elsewhere"; A's creates stay hidden from it.
      expect((await resolveIn(b)).answers).toMatchObject([
        { state: "missing" },
        { state: "document", inBranch: false, document: { id: live } },
        { state: "document", inBranch: true, branch: { branchId: branchB } },
      ]);
    });
    it("answers ref links through the route core: gone never carries a location", async () => {
      const db = database.current;
      const live = await add("manuscript", "live");
      const contextSourceId = sourceOf.get(live) as string;
      const sibling = (name: string) => seedDocument(contextSourceId, name);
      // The holder the request's base names: pinned, so its ahead answers read its bindings.
      await sibling("holder");
      const deleted = await sibling("deleted");
      // A discarded branch create is in no view: a row, and nowhere to read it.
      const discarded = crypto.randomUUID();
      await db.insert(documents).values({ id: discarded, projectId: p });
      const secret = await sibling("secret");
      await change(contextSourceId, (writer) => writer.delete(LIVE, "system", deleted));
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
      await seedDocument(otherSource, "foreign", { id: foreign });
      const settled = crypto.randomUUID();
      const unsettled = crypto.randomUUID();
      const settledGone = crypto.randomUUID();
      const occupied = crypto.randomUUID();
      await db.insert(linkAheadRefs).values([
        {
          aheadId: settledGone,
          projectId: p,
          scheme: "manuscript",
          path: "deleted",
          settledDocumentId: deleted,
        },
        // Rule 4: unsettled, answered by the document at its exact address.
        { aheadId: occupied, projectId: p, scheme: "manuscript", path: "live" },
        {
          aheadId: settled,
          projectId: p,
          scheme: "manuscript",
          path: "live",
          settledDocumentId: live,
        },
        { aheadId: unsettled, projectId: p, scheme: "manuscript", path: "later" },
      ]);
      const provisioned: (DraftOwner | null)[] = [];
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
          observer: createLinkScopeObserver(createNoopEventSink()),
        }),
        branches: {
          viewForOwner: async (owner) => {
            provisioned.push(owner);
            return { kind: "live" };
          },
        },
        workAuthorityResolver: createDrizzleProjectWorkAuthorityResolver(db),
        fileAccess: {
          async listAccess(_principal, ids) {
            return new Map(ids.map((id) => [id, {} as never]));
          },
        },
        documentTrash: { retained: async () => new Set() },
        files: { lookupDocuments: async () => [] },
      };
      const response = await handleDocumentLinkResolveRequest(deps, {
        projectId: p,
        userId: u as never,
        request: {
          baseUri: "manuscript://holder",
          links: [
            { ref: `doc:${live}`, href: "manuscript://old-live" },
            { ref: `doc:${deleted}`, href: "manuscript://deleted" },
            { ref: `doc:${discarded}`, href: "manuscript://discarded" },
            { ref: `doc:${secret}`, href: "manuscript://secret" },
            { ref: `doc:${foreign}`, href: "manuscript://foreign" },
            { ref: `ahead:${settled}`, href: "manuscript://elsewhere" },
            { ref: `ahead:${unsettled}`, href: "manuscript://later#scene" },
            { ref: `ahead:${settledGone}`, href: "manuscript://deleted" },
            { ref: `ahead:${occupied}`, href: "manuscript://live" },
            { ref: "doc:not-a-uuid", href: "manuscript://live" },
            { ref: null, href: "live" },
            { ref: null, href: "https://example.com" },
          ],
        },
      });
      const liveDocument = {
        state: "document",
        document: { id: live, title: "live", scheme: "manuscript", path: "live" },
        inBranch: false,
      };
      expect(response.answers).toMatchObject([
        liveDocument,
        { state: "gone" },
        { state: "gone" },
        { state: "gone" },
        { state: "gone" },
        liveDocument,
        { state: "missing", uri: "manuscript://later" },
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
      // A chat's lineage owns its drafts, so its links read the lineage's branch view.
      const root = crypto.randomUUID();
      await db
        .insert(threads)
        .values({ id: root, projectId: p, rootThreadId: root, createdByUserId: u, ref: "c1" });
      provisioned.length = 0;
      const noWorkBranch = await handleDocumentLinkResolveRequest(deps, {
        projectId: p,
        userId: u as never,
        request: {
          rootThreadId: root,
          baseUri: null,
          links: [{ ref: `doc:${discarded}`, href: "manuscript://discarded" }],
        },
      });
      // The tombstone stays gone; the chat's links read its lineage's branch view.
      expect(noWorkBranch.answers).toMatchObject([{ state: "gone" }]);
      expect(provisioned).toEqual([{ kind: "lineage", projectId: p, rootThreadId: root }]);
      // A Work of another project never reaches branch membership provisioning.
      const foreignWork = crypto.randomUUID();
      await db.insert(works).values({
        id: foreignWork,
        projectId: otherProject,
        createdByUserId: u,
        name: "Foreign",
        handle: "w4",
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
              links: [{ ref: `doc:${live}`, href: "manuscript://live" }],
            },
          }),
        )
        .rejects.toMatchObject({ statusCode: 404 });
      expect.soft(provisioned).toEqual([]);
    });
  });
}
