/**
 * Document-link scopes across doors: images in search, draft review, Apply and
 * live reversal, and a reply's own create spelled alike by every reader and by
 * a cold undo in the draft it changed.
 */
import { createDb } from "@meridian/database";
import {
  changeTrailDocumentDetails,
  documents,
  folders,
  modelResponses,
} from "@meridian/database/schema";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testFileGrant } from "../../test-support/file-grants.js";

import { ContextFS } from "../context/adapters/context-fs/context-fs.js";
import { DrizzleContextDocumentStore } from "../context/adapters/context-fs/drizzle-store.js";
import { DrizzleContextTreeMutationStore } from "../context/adapters/context-fs/drizzle-tree-mutation-store.js";
import type { LinkScopeKey } from "./domain/ports/document-link-scope.js";
import { writeMarkdown } from "./test-support/bound-writes.js";
import {
  createTestDocumentLinkScopes,
  lateBoundManifestMembership,
} from "./test-support/document-link-scopes.js";
import {
  createWorkDraftFixture,
  DOC_ID,
  DRAFT_DESTINATION,
  PROJECT_ID,
  SOURCE_ID,
  THREAD_ID,
  TURN_2_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/work-draft-fixture.js";

const documentSchema = buildDocumentSchema();

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("collab image paths (postgres)", () => {});
} else {
  describe("collab image paths (postgres)", () => {
    const queries: string[] = [];
    const db = createDb(DATABASE_URL, {
      max: 4,
      postgres: {
        debug: (_connection, query) => {
          queries.push(query);
        },
      },
    });
    const { hocuspocus, createTestCollab, reset, dispose, applyDraft, currentDraftId } =
      createWorkDraftFixture(db);
    beforeEach(reset);
    afterEach(dispose);
    afterAll(async () => {
      await db.$client.end();
    });
    /** A chapter showing `assets/map.png`, and the model's grant in this project. */
    async function seedChapterWithMap(collab: ReturnType<typeof createTestCollab>) {
      const ASSETS_ID = "00000000-0000-4000-8000-000000000711";
      await db
        .insert(folders)
        .values({ id: ASSETS_ID, contextSourceId: SOURCE_ID, name: "assets" });
      await db.insert(documents).values({
        id: "00000000-0000-4000-8000-000000000712",
        contextSourceId: SOURCE_ID,
        folderId: ASSETS_ID,
        name: "map",
        extension: "png",
        fileType: "image",
        mimeType: "image/png",
      });
      await writeMarkdown(collab, {
        documentId: DOC_ID as never,
        markdown: "Base.\n\n![Map](assets/map.png)",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID as never,
      });
      const grant = testFileGrant(DRAFT_DESTINATION, DOC_ID);
      await expect(
        collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "![Pass](assets/map.png) The pass.",
          },
          {
            sessionId: "session-map",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            grant: { ...grant, facts: { ...grant.facts, projectId: PROJECT_ID as never } },
          },
        ),
      ).resolves.toMatchObject({ status: "success" });
    }

    // The thread view exercises the same one-scope search as a writer's live
    // view, through a draft view; the adapter's snapshot reuse is pinned in
    // `document-link-scope.db.test.ts`.
    it("shares search paths across chapters in a thread view", async () => {
      const links = createTestDocumentLinkScopes(db);
      const collab = createTestCollab(links);
      collab.bindHocuspocus(hocuspocus as never);
      await seedChapterWithMap(collab);
      const secondDocumentId = "00000000-0000-4000-8000-000000000713";
      await db.insert(documents).values({
        id: secondDocumentId,
        contextSourceId: SOURCE_ID,
        name: "chapter-two",
        extension: "md",
        fileType: "markdown",
      });
      // Two uploads no path spells: a deleted cover whose path a new cover took,
      // and an id with no document behind it.
      const OLD_COVER = "00000000-0000-4000-8000-000000000718";
      const LOST = "00000000-0000-4000-8000-000000000719";
      const cover = { contextSourceId: SOURCE_ID, name: "cover", extension: "png" };
      await db.insert(documents).values([
        { ...cover, id: OLD_COVER, fileType: "image", deletedAt: new Date() },
        { ...cover, id: "00000000-0000-4000-8000-00000000071a", fileType: "image" },
      ]);
      await writeMarkdown(collab, {
        documentId: secondDocumentId as never,
        markdown: `See ![Map](assets/map.png), ![Old cover](asset:${OLD_COVER}) and ![Lost map](asset:${LOST}).`,
        origin: { type: "user", actorUserId: USER_ID as never },
      });
      let moveAfterRead = true;
      async function moveImage() {
        if (!moveAfterRead) return;
        moveAfterRead = false;
        await db.update(folders).set({ name: "art" }).where(eq(folders.contextSourceId, SOURCE_ID));
      }
      const context = new ContextFS({
        holder: { projectId: PROJECT_ID },
        scheme: "manuscript",
        links,
        store: new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID }),
        mutationStore: new DrizzleContextTreeMutationStore(db),
        threadView: {
          threadId: THREAD_ID,
          draftWork: { id: WORK_ID as never, slug: "work" },
        },
        documentSync: {
          ...collab,
          async readVersionedMarkdown(documentId) {
            const read = await collab.readVersionedMarkdown(documentId);
            await moveImage();
            return read;
          },
          async readEffectiveHashlines(command) {
            const read = await collab.readEffectiveHashlines(command);
            await moveImage();
            return read;
          },
        },
      });
      queries.length = 0;
      const hits = await context.search("map.png");
      // One snapshot for the whole search: its project resolved once, every
      // chapter's read joining it.
      expect(
        queries.filter((query) => query.includes("AS project_id, p.user_id::text AS owner")),
      ).toHaveLength(1);
      expect(hits.ok).toBe(true);
      if (!hits.ok) throw new Error(JSON.stringify(hits.error));
      expect(hits.value).toHaveLength(2);
      for (const hit of hits.value) {
        expect(JSON.stringify(hit.matches)).toContain("assets/map.png");
        expect(JSON.stringify(hit.matches)).not.toContain("art/map.png");
        expect(JSON.stringify(hit.matches)).not.toMatch(/asset:|doc:/);
        // The capture records the upload's identity where the read showed it.
        expect(hit.shown?.passages.flat()).toContainEqual({
          ref: "asset:00000000-0000-4000-8000-000000000712",
          address: "manuscript://assets/map.png",
        });
      }
      const next = await context.search("map.png");
      expect(next.ok).toBe(true);
      if (!next.ok) throw new Error(JSON.stringify(next.error));
      expect(next.value).toHaveLength(2);
      for (const hit of next.value) expect(JSON.stringify(hit.matches)).toContain("art/map.png");
      const second = hits.value.find((hit) => hit.documentId === secondDocumentId);
      expect(JSON.stringify(second?.matches)).toContain(
        "![Old cover](manuscript://cover.png) and ![Lost map]()",
      );

      // The model's read spells them alike, and records the deleted cover where it showed it.
      const grant = testFileGrant(DRAFT_DESTINATION, secondDocumentId);
      const read = await collab.agentEdit().read(
        { file: "chapter-two.md", documentId: secondDocumentId },
        {
          sessionId: "session-read",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          grant: { ...grant, facts: { ...grant.facts, projectId: PROJECT_ID as never } },
        },
      );
      expect.soft(JSON.stringify(read.result), "model read").not.toMatch(/asset:|doc:/);
      expect
        .soft(JSON.stringify(read.result), "model read")
        .toContain("![Old cover](manuscript://cover.png) and ![Lost map]()");
      expect.soft(read.showing?.links, "read showing").toContainEqual({
        ref: `asset:${OLD_COVER}`,
        address: "manuscript://cover.png",
      });
    });

    it("prepares preview links without whole-document serialization and fences a tree-only move", async () => {
      const links = createTestDocumentLinkScopes(db);
      let scopes = 0;
      const collab = createTestCollab({
        ...links,
        within: <T>(key: LinkScopeKey, operation: () => Promise<T>) => {
          scopes += 1;
          return links.within(key, operation);
        },
      });
      collab.bindHocuspocus(hocuspocus as never);
      await seedChapterWithMap(collab);
      const command = {
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        documentId: DOC_ID as never,
        draftId: await currentDraftId(collab, DOC_ID),
      };
      scopes = 0;
      const preview = await collab.draftReview.preview(command);
      expect(preview.status).toBe("active");
      if (preview.status !== "active") throw new Error("expected active preview");
      expect(preview).not.toHaveProperty("live");
      expect(preview).not.toHaveProperty("markdown");
      expect(scopes).toBe(1);
      await db.update(folders).set({ name: "art" }).where(eq(folders.contextSourceId, SOURCE_ID));
      const next = await collab.draftReview.preview(command);
      expect(next.status).toBe("active");
      if (next.status !== "active") throw new Error("expected active preview after move");
      expect(next.draftRevisionToken).not.toBe(preview.draftRevisionToken);
      const operation = preview.operations[0];
      await expect(
        collab.draftReview.applyWorkDraftChanges({
          ...command,
          userId: USER_ID as never,
          operationIds: preview.operations
            .filter((op) => op.closureClassId === operation.closureClassId)
            .map((op) => op.operationId),
          liveRevisionToken: preview.liveRevisionToken,
          draftRevisionToken: preview.draftRevisionToken,
        }),
      ).resolves.toMatchObject({ status: "stale" });
    });

    it("accepts a draft on a chapter with an image", async () => {
      const collab = createTestCollab();
      collab.bindHocuspocus(hocuspocus as never);
      await seedChapterWithMap(collab);

      await expect(
        collab.draftReview.applyWorkDraft({
          projectId: PROJECT_ID as never,
          workId: WORK_ID as never,
          documentId: DOC_ID as never,
          draftId: await currentDraftId(collab, DOC_ID),
          userId: USER_ID as never,
        }),
      ).resolves.toMatchObject({ status: "applied" });

      const details = await db
        .select({ changes: changeTrailDocumentDetails.changes })
        .from(changeTrailDocumentDetails)
        .where(eq(changeTrailDocumentDetails.documentId, DOC_ID as never));
      // The trail keeps block text, which an image has none of; the push's
      // snapshot of every block is what serializes the picture.
      const trail = JSON.stringify(details);
      expect(trail).toContain("The pass.");
      expect(trail).not.toContain("asset:");
    });

    it("spells a reply's own create alike at every door, and in its draft after a cold undo", async () => {
      // The real manifest authority: the created chapter exists only in this
      // reply's draft until it saves, and only for this thread.
      const manifest = lateBoundManifestMembership();
      const links = createTestDocumentLinkScopes(db, { membership: manifest.membership });
      const start = () => {
        const started = createTestCollab(links);
        manifest.bind(started);
        started.bindHocuspocus(hocuspocus as never);
        return started;
      };
      let collab = start();
      await collab.seedFromMarkdown(DOC_ID, collab.bindStatic("Holder."), { type: "system" });
      await collab.reconcileProjectManifest(PROJECT_ID as never);
      const CREATED_ID = "00000000-0000-4000-8000-000000000714";
      const RESPONSE_ID = "00000000-0000-4000-8000-000000000715";
      await db.insert(documents).values({
        id: CREATED_ID,
        contextSourceId: SOURCE_ID,
        name: "created",
        extension: "md",
      });
      await db.insert(modelResponses).values({
        id: RESPONSE_ID as never,
        turnId: TURN_ID as never,
        sequence: 0,
        provider: "mock",
        model: "mock",
        requestMessageCount: 0,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
      const granted = testFileGrant(DRAFT_DESTINATION, DOC_ID);
      const grant = {
        ...granted,
        principal: { ...granted.principal, accountId: USER_ID as never },
        facts: { ...granted.facts, projectId: PROJECT_ID as never },
      };
      const ctx = { sessionId: "session-create", threadId: THREAD_ID, turnId: TURN_ID, grant };
      const core = collab.agentEdit();
      await expect(
        core.write(
          { command: "create", file: "created.md", documentId: CREATED_ID, content: "New." },
          {
            ...ctx,
            grant: {
              ...grant,
              facts: {
                ...grant.facts,
                target: { kind: "document", documentId: CREATED_ID as never },
              },
            },
            responseId: RESPONSE_ID,
            createdDocument: true,
          },
        ),
      ).resolves.toMatchObject({ status: "success", phase: "staged" });
      const link = documentSchema.node("paragraph", null, [
        documentSchema.text("See created", [
          documentSchema.marks.link.create({
            ref: `doc:${CREATED_ID}`,
            href: "manuscript://stale-created.md",
          }),
        ]),
      ]);
      await expect(
        core.write(
          {
            command: "copy",
            from: { path: "created.md" },
            file: "chapter.md",
            documentId: DOC_ID,
            overwrite: true,
          },
          { ...ctx, responseId: RESPONSE_ID, createdDocument: false, copiedNodes: [link] },
        ),
      ).resolves.toMatchObject({ status: "success", phase: "staged" });

      const spelled = "[See created](created.md)";
      const view = {
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        responseId: RESPONSE_ID,
        destination: "draft" as const,
        workId: WORK_ID as never,
      };
      const read = await core.read(
        { file: "chapter.md", documentId: DOC_ID },
        { ...ctx, responseId: RESPONSE_ID },
      );
      const markdown = await collab.readEffectiveMarkdown(view);
      const hashlines = await collab.readEffectiveHashlines(view);
      const search = await new ContextFS({
        holder: { projectId: PROJECT_ID },
        scheme: "manuscript",
        links,
        store: new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID }),
        mutationStore: new DrizzleContextTreeMutationStore(db),
        manifestView: {
          projectId: PROJECT_ID,
          workId: WORK_ID,
          threadId: THREAD_ID,
          responseId: RESPONSE_ID,
        },
        threadView: {
          threadId: THREAD_ID,
          responseId: RESPONSE_ID,
          draftWork: { id: WORK_ID as never, slug: "work" },
        },
        documentSync: collab,
      }).search("See created");
      if (!markdown.ok || !hashlines.ok || !search.ok) {
        throw new Error(JSON.stringify({ markdown, hashlines, search }));
      }
      const hit = search.value.find((each) => each.documentId === DOC_ID);
      expect.soft(JSON.stringify(read.result), "model read").toContain(spelled);
      expect.soft(markdown.value.content, "effective Markdown").toContain(spelled);
      expect.soft(hashlines.value.content.join("\n"), "effective hashlines").toContain(spelled);
      expect.soft(JSON.stringify(hit?.matches), "search").toContain(spelled);
      expect.soft(read.revision).toMatch(/^y2:/);
      expect
        .soft([markdown.value.revision, hashlines.value.revision, hit?.revision], "one view")
        .toEqual([read.revision, read.revision, read.revision]);

      // Saved, then written again; a fresh process undoes that write in the
      // draft it landed in, so its echo spells there and its token is the
      // draft read's.
      await collab.finalizeResponseCommit(RESPONSE_ID, {
        threadId: THREAD_ID as never,
        turnId: TURN_ID as never,
      });
      await collab.recordManifestDocumentCreated(CREATED_ID as never, {
        projectId: PROJECT_ID as never,
        workId: WORK_ID as never,
        threadId: THREAD_ID as never,
      });
      await expect(
        core.write(
          { command: "insert", file: "chapter.md", documentId: DOC_ID, content: "Suffix." },
          { ...ctx, turnId: TURN_2_ID },
        ),
      ).resolves.toMatchObject({ status: "success", phase: "committed" });
      const draftRead = {
        documentId: DOC_ID as never,
        threadId: THREAD_ID as never,
        destination: "draft" as const,
        workId: WORK_ID as never,
      };
      // Read back (pulling the thread's peer) before the process goes away.
      const before = await collab.readEffectiveHashlines(draftRead);
      expect(before.ok && before.value.content.join("\n")).toContain("Suffix.");
      await collab.documentDerivations.stop();
      collab.dispose();
      collab = start();
      const undone = await collab.agentEdit().undo(DOC_ID, THREAD_ID);
      const after = await collab.readEffectiveHashlines(draftRead);
      if (!after.ok) throw new Error(JSON.stringify(after));
      expect(undone.status).toBe("reversed");
      expect.soft(JSON.stringify(undone.result), "cold undo echo").toContain(spelled);
      expect.soft(after.value.content.join("\n")).toContain(spelled);
      expect.soft(undone.revision, "cold undo token").toBe(after.value.revision);

      // The same comparison in live: a reply that creates a chapter live sees it
      // in its own live view, never in baseline live or its draft view.
      const LIVE_CREATED_ID = "00000000-0000-4000-8000-000000000716";
      const LIVE_RESPONSE_ID = "00000000-0000-4000-8000-000000000717";
      await db.insert(documents).values({
        id: LIVE_CREATED_ID,
        contextSourceId: SOURCE_ID,
        name: "live-created",
        extension: "md",
      });
      await db.insert(modelResponses).values({
        id: LIVE_RESPONSE_ID as never,
        turnId: TURN_ID as never,
        sequence: 1,
        provider: "mock",
        model: "mock",
        requestMessageCount: 0,
        predictedCacheState: "cold",
        predictedCacheReason: "facts_unavailable",
      });
      await expect(
        collab.agentEdit().write(
          {
            command: "create",
            file: "live-created.md",
            documentId: LIVE_CREATED_ID,
            content: "Live.",
          },
          {
            ...ctx,
            grant: {
              ...grant,
              destination: { kind: "live" },
              facts: {
                ...grant.facts,
                target: { kind: "document", documentId: LIVE_CREATED_ID as never },
              },
            },
            responseId: LIVE_RESPONSE_ID,
            createdDocument: true,
          },
        ),
      ).resolves.toMatchObject({ status: "success", phase: "staged" });
      await links.within(
        { projectId: PROJECT_ID, viewer: { accountId: USER_ID, threadId: THREAD_ID } },
        async () => {
          const replyLive = { kind: "live", responseId: LIVE_RESPONSE_ID } as const;
          const replyDraft = {
            kind: "draft",
            workId: WORK_ID,
            responseId: LIVE_RESPONSE_ID,
          } as const;
          const views = [replyLive, { kind: "live" } as const, replyDraft];
          await links.prepare({
            holders: views.map((each) => ({ documentId: DOC_ID, view: each })),
            refs: [`doc:${LIVE_CREATED_ID}`],
          });
          const link = { ref: `doc:${LIVE_CREATED_ID}`, href: "manuscript://stale.md" };
          const [ownLive, baseline, ownDraft] = views.map((each) =>
            links.holder({ documentId: DOC_ID, view: each }),
          );
          expect
            .soft(ownLive?.spellLink(link).href, "the reply's live view")
            .toBe("live-created.md");
          expect.soft(baseline?.resolve(link), "baseline live").toEqual({ kind: "gone" });
          expect.soft(ownDraft?.resolve(link), "the reply's draft view").toEqual({ kind: "gone" });
        },
      );
      await collab.agentEdit().rollbackResponse(LIVE_RESPONSE_ID);
    });

    it("undoes and redoes a live turn on a chapter with an image", async () => {
      const collab = createTestCollab();
      collab.bindHocuspocus(hocuspocus as never);
      await seedChapterWithMap(collab);
      await applyDraft(collab, DOC_ID);

      for (const direction of ["undo", "redo"] as const) {
        const outcome = await collab.reverseTurn({
          threadId: THREAD_ID as never,
          turnId: TURN_ID as never,
          direction,
          actor: { type: "user", userId: USER_ID },
        });
        expect(outcome.status, JSON.stringify(outcome)).toBe("reversed");
        expect(JSON.stringify(outcome)).not.toContain("asset:");
      }
      await expectMarkdown(collab, DOC_ID, "![Pass](assets/map.png) The pass.");
    });
  });
}
async function expectMarkdown(
  collab: {
    readAsMarkdown(documentId: string): Promise<{ ok: true; value: string } | { ok: false }>;
  },
  documentId: string,
  expected: string,
) {
  const read = await collab.readAsMarkdown(documentId);
  expect(read.ok ? read.value : "").toContain(expected);
}
