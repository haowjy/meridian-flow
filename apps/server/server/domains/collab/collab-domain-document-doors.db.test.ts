/** Consolidated test contracts; each block retains its original fixture scope. */

import { createDb } from "@meridian/database";
import {
  changeTrailDocumentDetails,
  documents,
  draftTreeChanges,
  folders,
  modelResponses,
} from "@meridian/database/schema";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq, sql } from "drizzle-orm";
import { describe as __mergedSuite, afterAll, afterEach, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import { asGrantedWriter, testFileGrant } from "../../test-support/file-grants.js";
import { ContextFS } from "../context/adapters/context-fs/context-fs.js";
import { DrizzleContextDocumentStore } from "../context/adapters/context-fs/drizzle-store.js";
import { DrizzleContextTreeMutationStore } from "../context/adapters/context-fs/drizzle-tree-mutation-store.js";
import { applyDraftDocument } from "./test-support/apply-draft-document.js";
import { writeMarkdown } from "./test-support/bound-writes.js";
import { createTestDocumentLinkScopes } from "./test-support/document-link-scopes.js";
import {
  CREATED_DOC_ID,
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

__mergedSuite("collab-domain.image-paths.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/collab-domain.image-paths.db.test.ts.
  const documentSchema = buildDocumentSchema();

  const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  const DATABASE_URL = process.env.DATABASE_URL;

  if (!RUN_DB_TESTS || !DATABASE_URL) {
    __mergedSuite.skip("collab image paths (postgres)", () => {});
  } else {
    const identity = (responseId: string) => ({
      providerResponseId: responseId,
      editScopeId: responseId,
    });
    __mergedSuite("collab image paths (postgres)", () => {
      const queries: string[] = [];
      const db = createDb(DATABASE_URL, {
        max: 4,
        postgres: {
          debug: (_connection, query) => {
            queries.push(query);
          },
        },
      });
      const { hocuspocus, createTestCollab, reset, dispose, applyDraft } =
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
              file: "chapter",
              documentId: DOC_ID,
              content: "![Pass](assets/map.png) The pass.",
            },
            {
              sessionId: "session-map",
              threadId: THREAD_ID,
              turnId: TURN_ID,
              grant: {
                ...grant,
                facts: { ...grant.facts, projectId: PROJECT_ID as never },
              },
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
          extension: "",
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
          await db
            .update(folders)
            .set({ name: "art" })
            .where(eq(folders.contextSourceId, SOURCE_ID));
        }
        const context = new ContextFS({
          placement: { kind: "live" },
          holder: { projectId: PROJECT_ID },
          scheme: "manuscript",
          links,
          store: new DrizzleContextDocumentStore({
            db,
            contextSourceId: SOURCE_ID,
          }),
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
          { file: "chapter-two", documentId: secondDocumentId },
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
      it("accepts a draft on a chapter with an image", async () => {
        const collab = createTestCollab();
        collab.bindHocuspocus(hocuspocus as never);
        await seedChapterWithMap(collab);
        await expect(
          applyDraftDocument(collab.draftReview, {
            workId: WORK_ID as never,
            documentId: DOC_ID as never,
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
        // All effective rendering doors share the real tree-backed scope.
        const links = createTestDocumentLinkScopes(db);
        const start = () => {
          const started = createTestCollab(links);
          started.bindHocuspocus(hocuspocus as never);
          return started;
        };
        let collab = start();
        await collab.seedFromMarkdown(DOC_ID, collab.bindStatic("Holder."), {
          type: "system",
        });
        const CREATED_ID = "00000000-0000-4000-8000-000000000714";
        const RESPONSE_ID = "00000000-0000-4000-8000-000000000715";
        // The Work's draft created this chapter: a hidden row and the draft's created row,
        // as ContextFS leaves a model's create in a draft-mode Work.
        const draft = await collab.drafts.ensureActiveForWrite({
          workId: WORK_ID as never,
          projectId: PROJECT_ID as never,
          threadId: THREAD_ID as never,
          userId: USER_ID as never,
        });
        await db.insert(documents).values({
          id: CREATED_ID,
          contextSourceId: SOURCE_ID,
          name: "created",
          extension: "",
          hidden: true,
        });
        await db.insert(draftTreeChanges).values({
          draftId: draft.id,
          nodeKind: "document",
          nodeId: CREATED_ID,
          created: true,
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
        const ctx = {
          sessionId: "session-create",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          grant,
        };
        const core = collab.agentEdit();
        await expect(
          core.write(
            { command: "create", file: "created", documentId: CREATED_ID, content: "New." },
            {
              ...ctx,
              grant: {
                ...grant,
                facts: {
                  ...grant.facts,
                  target: { kind: "document", documentId: CREATED_ID as never },
                },
              },
              responseIdentity: identity(RESPONSE_ID),
              createdDocument: true,
            },
          ),
        ).resolves.toMatchObject({ status: "success", phase: "staged" });
        const link = documentSchema.node("paragraph", null, [
          documentSchema.text("See created", [
            documentSchema.marks.link.create({
              ref: `doc:${CREATED_ID}`,
              href: "manuscript://stale-created",
            }),
          ]),
        ]);
        await expect(
          core.write(
            {
              command: "copy",
              from: { path: "created" },
              file: "chapter",
              documentId: DOC_ID,
              overwrite: true,
            },
            {
              ...ctx,
              responseIdentity: identity(RESPONSE_ID),
              createdDocument: false,
              copiedNodes: [link],
            },
          ),
        ).resolves.toMatchObject({ status: "success", phase: "staged" });
        const spelled = "[See created](created)";
        const view = {
          documentId: DOC_ID as never,
          threadId: THREAD_ID as never,
          responseId: RESPONSE_ID,
          destination: "draft" as const,
          workId: WORK_ID as never,
        };
        const read = await core.read(
          { file: "chapter", documentId: DOC_ID },
          { ...ctx, responseIdentity: identity(RESPONSE_ID) },
        );
        const markdown = await collab.readEffectiveMarkdown(view);
        const hashlines = await collab.readEffectiveHashlines(view);
        const search = await new ContextFS({
          placement: { kind: "live" },
          holder: { projectId: PROJECT_ID },
          scheme: "manuscript",
          links,
          store: new DrizzleContextDocumentStore({
            db,
            contextSourceId: SOURCE_ID,
          }),
          mutationStore: new DrizzleContextTreeMutationStore(db),
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
        await collab.finalizeResponseCommit(identity(RESPONSE_ID), {
          threadId: THREAD_ID as never,
          turnId: TURN_ID as never,
        });
        await expect(
          core.write(
            {
              command: "insert",
              file: "chapter",
              documentId: DOC_ID,
              content: "Suffix.",
            },
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
        const undone = await collab
          .agentEdit()
          .write(
            { command: "undo", file: "chapter", documentId: DOC_ID },
            { ...ctx, turnId: TURN_2_ID },
          );
        const after = await collab.readEffectiveHashlines(draftRead);
        if (!after.ok) throw new Error(JSON.stringify(after));
        expect(undone.status).toBe("success");
        expect.soft(JSON.stringify(undone.result), "cold undo echo").toContain(spelled);
        expect.soft(after.value.content.join("\n")).toContain(spelled);
        expect.soft(undone.revision, "cold undo token").toBe(after.value.revision);
        // The same comparison in live. A create is a row, not a reply's in-memory set: a live
        // create is visible in every view at once, and the draft's hidden create is "in a
        // draft" in both views, spelled at its path only where its draft can read it.
        const LIVE_CREATED_ID = "00000000-0000-4000-8000-000000000716";
        const LIVE_RESPONSE_ID = "00000000-0000-4000-8000-000000000717";
        await db.insert(documents).values({
          id: LIVE_CREATED_ID,
          contextSourceId: SOURCE_ID,
          name: "live-created",
          extension: "",
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
              file: "live-created",
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
              responseIdentity: identity(LIVE_RESPONSE_ID),
              createdDocument: true,
            },
          ),
        ).resolves.toMatchObject({ status: "success", phase: "staged" });
        await links.within(
          {
            projectId: PROJECT_ID,
            viewer: { accountId: USER_ID, threadId: THREAD_ID },
          },
          async () => {
            const live = { kind: "live" } as const;
            const drafted = { kind: "draft", draftId: draft.id } as const;
            await links.prepare({
              holders: [live, drafted].map((view) => ({ documentId: DOC_ID, view })),
              refs: [`doc:${LIVE_CREATED_ID}`, `doc:${CREATED_ID}`],
            });
            const [inLive, inDraft] = [live, drafted].map((view) =>
              links.holder({ documentId: DOC_ID, view }),
            );
            const liveCreate = { ref: `doc:${LIVE_CREATED_ID}`, href: "manuscript://stale" };
            const draftCreate = { ref: `doc:${CREATED_ID}`, href: "manuscript://stale-created" };
            expect
              .soft(inLive?.spellLink(liveCreate).href, "live create, live")
              .toBe("live-created");
            expect
              .soft(inDraft?.resolve(liveCreate), "live create, draft")
              .toMatchObject({ kind: "document", inDraft: false });
            expect
              .soft(inLive?.resolve(draftCreate), "draft create, live")
              .toMatchObject({ kind: "document", inDraft: true });
            expect
              .soft(inDraft?.resolve(draftCreate), "draft create, its draft")
              .toMatchObject({ kind: "document", inDraft: true });
            expect
              .soft(inDraft?.spellLink(draftCreate).href, "draft create spelled in its draft")
              .toBe("created");
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
      readAsMarkdown(documentId: string): Promise<
        | {
            ok: true;
            value: string;
          }
        | {
            ok: false;
          }
      >;
    },
    documentId: string,
    expected: string,
  ) {
    const read = await collab.readAsMarkdown(documentId);
    expect(read.ok ? read.value : "").toContain(expected);
  }
});

__mergedSuite("collab-domain.reverse-turn.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/collab-domain.reverse-turn.db.test.ts.
  const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  const DATABASE_URL = process.env.DATABASE_URL;

  if (!RUN_DB_TESTS || !DATABASE_URL) {
    __mergedSuite.skip("collab domain reverseTurn (postgres)", () => {});
  } else {
    __mergedSuite("collab domain reverseTurn (postgres)", async () => {
      const { createDb } = await import("@meridian/database");
      const {
        branchWriteJournal,
        documentMarkdownProjections,
        documentYjsUpdates,
        documents,
        modelResponses,
      } = await import("@meridian/database/schema");
      const { createDrizzleJournal } = await import("./adapters/drizzle-journal.js");
      const db = createDb(DATABASE_URL, { max: 4 });
      const { hocuspocus, createTestCollab, reset, dispose, applyDraft } =
        createWorkDraftFixture(db);
      afterEach(dispose);
      beforeEach(reset);
      afterAll(async () => {
        await db.$client.end();
      });
      it("ContextFS cannot republish a stale write return over the certified projection", async () => {
        const { ContextFS } = await import("../context/adapters/context-fs/context-fs.js");
        const { DrizzleContextDocumentStore } = await import(
          "../context/adapters/context-fs/drizzle-store.js"
        );
        const { DrizzleContextTreeMutationStore } = await import(
          "../context/adapters/context-fs/drizzle-tree-mutation-store.js"
        );
        const collab = createTestCollab();
        collab.bindHocuspocus(hocuspocus as never);
        await db.insert(modelResponses).values({
          id: TURN_ID,
          turnId: TURN_ID,
          sequence: 0,
          provider: "mock",
          model: "mock",
          requestMessageCount: 0,
          predictedCacheState: "cold",
          predictedCacheReason: "facts_unavailable",
        });
        const context = new ContextFS({
          placement: { kind: "live" },
          holder: { projectId: PROJECT_ID },
          links: createTestDocumentLinkScopes(db),
          scheme: "manuscript",
          store: new DrizzleContextDocumentStore({ db, contextSourceId: SOURCE_ID }),
          mutationStore: new DrizzleContextTreeMutationStore(db),
          documentCreation: collab,
          documentSync: {
            ...collab,
            async writeDocument(input) {
              const result = await collab.writeDocument(input);
              // Reproduce the old publisher boundary without claiming a socket race:
              // the returned serialization must never overwrite a certified cut.
              return { ...result, markdown: "stale return value" };
            },
          },
        });
        try {
          const created = await context.write("fresh.md", "Seed.");
          expect(created.ok).toBe(true);
          if (!created.ok || !created.value.documentId) throw new Error("Missing created document");
          await expect(
            asGrantedWriter(() =>
              context.write("fresh.md", "Current café.", {
                origin: {
                  type: "agent",
                  agentSlug: "writer",
                  turnId: TURN_ID as never,
                  threadId: THREAD_ID as never,
                },
              }),
            ),
          ).resolves.toMatchObject({
            ok: true,
          });
          const [row] = await db
            .select({
              sizeBytes: documents.sizeBytes,
              markdown: documentMarkdownProjections.markdown,
            })
            .from(documents)
            .leftJoin(
              documentMarkdownProjections,
              eq(documentMarkdownProjections.documentId, documents.id),
            )
            .where(eq(documents.id, created.value.documentId));
          expect(row?.markdown).toBe("Current café.\n");
          expect(row?.sizeBytes).toBe(Buffer.byteLength("Current café.\n", "utf8"));
        } finally {
          await collab.documentDerivations.stop();
        }
      });
      it("undoes and redoes overlapping replace and delete writes as one turn", async () => {
        const collab = createTestCollab();
        collab.bindHocuspocus(hocuspocus as never);
        const fountain =
          "The fountain wore a skin of ice, each dark stone mirroring the colorless winter sky.";
        const gate =
          "At the gate, Captain Ilyan waited in silence, his gloved hand closed around the iron latch.";
        await writeMarkdown(collab, {
          documentId: DOC_ID as never,
          markdown: fountain,
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID as never,
        });
        for (const [find, content] of [
          [fountain, gate],
          [gate, ""],
        ] as const) {
          await expect(
            collab.agentEdit().write(
              {
                command: "replace",
                file: "chapter.md",
                documentId: DOC_ID,
                find,
                content,
              },
              {
                sessionId: "session-overlap",
                threadId: THREAD_ID,
                turnId: TURN_ID,
                grant: testFileGrant(DRAFT_DESTINATION),
              },
            ),
          ).resolves.toMatchObject({ status: "success" });
          await applyDraft(collab, DOC_ID);
        }
        const undo = await collab.reverseTurn({
          threadId: THREAD_ID as never,
          turnId: TURN_ID as never,
          direction: "undo",
          actor: { type: "user", userId: USER_ID },
        });
        expect(["reversed", "reconciled"]).toContain(undo.status);
        await expectMarkdown(collab, DOC_ID, fountain);
        const redo = await collab.reverseTurn({
          threadId: THREAD_ID as never,
          turnId: TURN_ID as never,
          direction: "redo",
          actor: { type: "user", userId: USER_ID },
        });
        expect(redo.status).toBe("reversed");
        expect(await readMarkdown(collab, DOC_ID)).not.toContain(fountain);
      });
      it("undoes the independent document and names the part edited by the writer", async () => {
        await db.insert(documents).values({
          id: CREATED_DOC_ID,
          contextSourceId: SOURCE_ID,
          name: "chapter-two",
          extension: "md",
          fileType: "markdown",
        });
        const collab = createTestCollab();
        collab.bindHocuspocus(hocuspocus as never);
        for (const [documentId, markdown] of [
          [DOC_ID, "First base."],
          [CREATED_DOC_ID, "Second base."],
        ] as const) {
          await writeMarkdown(collab, {
            documentId: documentId as never,
            markdown,
            origin: { type: "user", actorUserId: USER_ID as never },
            threadId: THREAD_ID as never,
          });
          await expect(
            collab.agentEdit().write(
              {
                command: "insert",
                file: `${documentId}.md`,
                documentId,
                content: `Turn edit for ${documentId}.`,
              },
              {
                sessionId: "session-atomic-reversal",
                threadId: THREAD_ID,
                turnId: TURN_ID,
                grant: testFileGrant(DRAFT_DESTINATION),
              },
            ),
          ).resolves.toMatchObject({ status: "success" });
          await applyDraft(collab, documentId);
        }
        await writeMarkdown(collab, {
          documentId: CREATED_DOC_ID as never,
          markdown: "Writer invalidated only the second document.",
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID as never,
        });
        await expect(
          collab.reverseTurn({
            threadId: THREAD_ID as never,
            turnId: TURN_ID as never,
            direction: "undo",
            actor: { type: "user", userId: USER_ID },
          }),
        ).resolves.toMatchObject({
          status: "partial",
          acceptedParts: 1,
          skips: [
            expect.objectContaining({
              after: `Turn edit for ${CREATED_DOC_ID}.`,
            }),
          ],
        });
        expect(await readMarkdown(collab, DOC_ID)).toBe("First base.\n");
        await expectMarkdown(
          collab,
          CREATED_DOC_ID,
          "Writer invalidated only the second document.",
        );
      });
      it("keeps redo after a writer edit to an unrelated paragraph", async () => {
        const collab = createTestCollab();
        collab.bindHocuspocus(hocuspocus as never);
        await writeMarkdown(collab, {
          documentId: DOC_ID as never,
          markdown: "Base.",
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID as never,
        });
        await collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Agent change.",
          },
          {
            sessionId: "session-writer-redo",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            grant: testFileGrant(DRAFT_DESTINATION),
          },
        );
        await applyDraft(collab, DOC_ID);
        await collab.reverseTurn({
          threadId: THREAD_ID as never,
          turnId: TURN_ID as never,
          direction: "undo",
          actor: { type: "user", userId: USER_ID },
        });
        await writeMarkdown(collab, {
          documentId: DOC_ID as never,
          markdown: "Writer changed the manuscript.",
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID as never,
        });
        const [writerRow] = await db
          .select({ id: documentYjsUpdates.id })
          .from(documentYjsUpdates)
          .where(eq(documentYjsUpdates.documentId, DOC_ID as never))
          .orderBy(sql`${documentYjsUpdates.id} desc`)
          .limit(1);
        if (!writerRow) throw new Error("missing writer update");
        // Collab ingress stores `user`; context-service writes store `human`.
        // Reconstruction must normalize both to the same writer class.
        await db
          .update(documentYjsUpdates)
          .set({ originType: "user" })
          .where(eq(documentYjsUpdates.id, writerRow.id));
        await expect(
          collab.getTurnReceiptChip(THREAD_ID as never, TURN_ID as never),
        ).resolves.toEqual(expect.objectContaining({ state: "live-reversed", control: "redo" }));
        await expect(
          collab.reverseTurn({
            threadId: THREAD_ID as never,
            turnId: TURN_ID as never,
            direction: "redo",
            actor: { type: "user", userId: USER_ID },
          }),
        ).resolves.toMatchObject({ status: "reversed" });
        expect(await readMarkdown(collab, DOC_ID)).toBe(
          "Writer changed the manuscript.\n\nAgent change.\n",
        );
      });
      it("degrades live turn undo when a later writer edit intersects the pushed paragraph", async () => {
        const collab = createTestCollab();
        collab.bindHocuspocus(hocuspocus as never);
        await writeMarkdown(collab, {
          documentId: DOC_ID as never,
          markdown: "Base.",
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID as never,
        });
        await collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Agent paragraph.",
          },
          {
            sessionId: "session-live-dependent",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            grant: testFileGrant(DRAFT_DESTINATION),
          },
        );
        await applyDraft(collab, DOC_ID);
        await writeMarkdown(collab, {
          documentId: DOC_ID as never,
          // A pure insertion anchored inside agent-born text: both the chip and the
          // real undo must treat it as dependent.
          markdown: "Base.\n\nAgent HUMAN-KEEP paragraph.",
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID as never,
        });
        await expect(
          collab.getTurnReceiptChip(THREAD_ID as never, TURN_ID as never),
        ).resolves.toEqual(expect.objectContaining({ state: "expired", control: "view_change" }));
        const reversed = await collab.reverseTurn({
          threadId: THREAD_ID as never,
          turnId: TURN_ID as never,
          direction: "undo",
          actor: { type: "user", userId: USER_ID },
        });
        expect(reversed.status).toBe("expired");
        expect(await readMarkdown(collab, DOC_ID)).toContain("Agent HUMAN-KEEP paragraph.");
      });
      it("keeps live turn undo available when a later writer edit is elsewhere", async () => {
        const collab = createTestCollab();
        collab.bindHocuspocus(hocuspocus as never);
        await writeMarkdown(collab, {
          documentId: DOC_ID as never,
          markdown: "Base.",
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID as never,
        });
        await collab.agentEdit().write(
          {
            command: "insert",
            file: "chapter.md",
            documentId: DOC_ID,
            content: "Agent paragraph.",
          },
          {
            sessionId: "session-live-independent",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            grant: testFileGrant(DRAFT_DESTINATION),
          },
        );
        await applyDraft(collab, DOC_ID);
        const unrelatedDoc = new Y.Doc({ gc: false });
        unrelatedDoc.getMap("elsewhere").set("note", "writer edit outside the agent paragraph");
        await createDrizzleJournal(db).append(DOC_ID, Y.encodeStateAsUpdate(unrelatedDoc), {
          origin: `human:${USER_ID}`,
          seq: 0,
        });
        unrelatedDoc.destroy();
        await expect(
          collab.getTurnReceiptChip(THREAD_ID as never, TURN_ID as never),
        ).resolves.toEqual(expect.objectContaining({ state: "live-active", control: "undo" }));
        const reversed = await collab.reverseTurn({
          threadId: THREAD_ID as never,
          turnId: TURN_ID as never,
          direction: "undo",
          actor: { type: "user", userId: USER_ID },
        });
        expect(reversed.status).toBe("reversed");
        const live = await readMarkdown(collab, DOC_ID);
        expect(live).toContain("Base.");
        expect(live).not.toContain("Agent paragraph.");
      });
      it("durably commits distinct responses that reuse a provider-local tool id", async () => {
        const collab = createTestCollab();
        collab.bindHocuspocus(hocuspocus as never);
        await writeMarkdown(collab, {
          documentId: DOC_ID as never,
          markdown: "Base.",
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID as never,
        });
        await expect(
          collab.agentEdit().write(
            {
              command: "insert",
              file: "chapter.md",
              documentId: DOC_ID,
              content: "First reused tool id.",
              tool_use_id: "call_mock_write_1",
            },
            {
              sessionId: "session-reused-provider-tool-id-db",
              grant: testFileGrant(DRAFT_DESTINATION),
              threadId: THREAD_ID,
              turnId: TURN_ID,
              responseIdentity: {
                providerResponseId: "response-reused-provider-tool-id-db-a",
                editScopeId: "response-reused-provider-tool-id-db-a",
              },
            },
          ),
        ).resolves.toMatchObject({ status: "success" });
        await collab.finalizeResponseCommit(
          {
            providerResponseId: "response-reused-provider-tool-id-db-a",
            editScopeId: "response-reused-provider-tool-id-db-a",
          },
          {
            threadId: THREAD_ID as never,
            turnId: TURN_ID as never,
          },
        );
        await expect(
          collab.agentEdit().write(
            {
              command: "insert",
              file: "chapter.md",
              documentId: DOC_ID,
              content: "Second reused tool id.",
              tool_use_id: "call_mock_write_1",
            },
            {
              sessionId: "session-reused-provider-tool-id-db",
              grant: testFileGrant(DRAFT_DESTINATION),
              threadId: THREAD_ID,
              turnId: TURN_2_ID,
              responseIdentity: {
                providerResponseId: "response-reused-provider-tool-id-db-b",
                editScopeId: "response-reused-provider-tool-id-db-b",
              },
            },
          ),
        ).resolves.toMatchObject({ status: "success" });
        await collab.finalizeResponseCommit(
          {
            providerResponseId: "response-reused-provider-tool-id-db-b",
            editScopeId: "response-reused-provider-tool-id-db-b",
          },
          {
            threadId: THREAD_ID as never,
            turnId: TURN_2_ID as never,
          },
        );
        const rows = await db
          .select({ id: branchWriteJournal.id, status: branchWriteJournal.status })
          .from(branchWriteJournal)
          .orderBy(branchWriteJournal.id);
        expect(rows).toEqual([
          expect.objectContaining({ status: "active" }),
          expect.objectContaining({ status: "active" }),
        ]);
      });
    });
  }

  async function expectMarkdown(
    collab: {
      readAsMarkdown(documentId: string): Promise<
        | {
            ok: true;
            value: string;
          }
        | {
            ok: false;
          }
      >;
    },
    documentId: string,
    expected: string,
  ) {
    const read = await collab.readAsMarkdown(documentId);
    expect(read.ok ? read.value : "").toContain(expected);
  }

  async function readMarkdown(
    collab: {
      readAsMarkdown(documentId: string): Promise<
        | {
            ok: true;
            value: string;
          }
        | {
            ok: false;
          }
      >;
    },
    documentId: string,
  ): Promise<string> {
    const read = await collab.readAsMarkdown(documentId);
    return read.ok ? read.value : "";
  }
});
