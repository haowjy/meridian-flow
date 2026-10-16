/** Consolidated test contracts; each block retains its original fixture scope. */

import { randomUUID } from "node:crypto";
import type { DocumentId } from "@meridian/contracts";
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { documentBranches, documents, drafts, works } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { describe as __mergedSuite, expect, it } from "vitest";
/** Draft review respects Work lifecycle while preserving pending items through restore. */
import { handleDocumentAddressRequest } from "../../lib/document-address-route.js";
import {
  handleApplyAllWorkDraftRequest,
  handleApplyWorkDraftChangesRequest,
  handleApplyWorkDraftRequest,
  handleDiscardAllWorkDraftRequest,
  handleDiscardWorkDraftRequest,
  handleDocumentDraftHintsRequest,
  handleWorkDraftListRequest,
  handleWorkDraftPreviewRequest,
  selectDraftRouteServices,
} from "../../lib/draft-review-route.js";
import { describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";
import { isDrafted } from "../file-policy/index.js";
import { deleteWorkTransition, restoreWork } from "../projects/index.js";

__mergedSuite("draft-items.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/draft-items.db.test.ts.
  describeDraftTreeDb("review items (postgres)", (start) => {
    it("a created document is a whole-item row: a per-change request refuses, item Discard of one leaves the other", async () => {
      const { runtime, s } = await start();
      const work = await s.work("Ascension", "draft");
      const empty = async (path: string) => {
        const answer = await s
          .model(work)
          .now("write", { command: "create", path: `manuscript://${path}` });
        expect(answer.isError).not.toBe(true);
        return (await s.view(work).idAt(path)) as DocumentId;
      };
      const kept = await empty("notes/kept.md");
      const dropped = await empty("notes/dropped.md");
      const items = await s.items(work);
      expect(items.map((item) => [item.documentId, item.wholeItem]).sort()).toEqual(
        [
          [kept, true],
          [dropped, true],
        ].sort(),
      );
      const deps = selectDraftRouteServices(runtime.app);
      const scope = { projectId: s.project.id, workId: work.id, userId: s.project.userId };
      const keptItem = items.find((item) => item.documentId === kept);
      if (!keptItem) throw new Error("no kept item");
      const perChange = await handleApplyWorkDraftChangesRequest(deps, {
        ...scope,
        documentId: kept,
        request: {
          draftId: keptItem.draftId,
          itemKey: keptItem.itemKey,
          commandId: randomUUID(),
          operationIds: ["1"],
          liveRevisionToken: "x",
          draftRevisionToken: "x",
        },
      });
      expect(perChange.body).toMatchObject({ status: "whole_item" });
      // Item Discard of one created item leaves the other and the draft active.
      const [discarded] = (await s.discard(work, [dropped])) as {
        status: string;
      }[];
      expect(discarded).toMatchObject({ status: "discarded" });
      expect((await s.items(work)).map((item) => item.documentId)).toEqual([kept]);
      expect(await s.draftStatuses(work)).toEqual(["active"]);
      expect(await s.apply(work, [kept], { tokens: "none" }).catch(() => null)).not.toBeNull();
    });
    it("1.2: a draft id, a branch id or another Work's item key never names an item", async () => {
      const { runtime, s } = await start();
      const work = await s.work("Ascension", "draft");
      const other = await s.work("Rival", "draft");
      const chapter = await s.writer.createDocument("chapter.md", "Opening.");
      await s.model(work).edit("chapter.md", "Opening.", "Opening, drafted.");
      await s.model(other).edit("chapter.md", "Opening.", "Opening, rival.");
      const [mine] = await s.items(work);
      const [theirs] = await s.items(other);
      if (!mine || !theirs) throw new Error("both Works draft the chapter");
      const { branchId: branch } = await s.draftBranch(work, chapter);
      const deps = selectDraftRouteServices(runtime.app);
      const scope = { projectId: s.project.id, workId: work.id, userId: s.project.userId };
      const review = runtime.ports.documentSync.draftReview;
      for (const wrong of [mine.draftId, branch, theirs.itemKey]) {
        expect(await review.resolveItem({ workId: work.id, itemKey: wrong })).toBeNull();
        expect(await review.preview({ workId: work.id, itemKey: wrong })).toMatchObject({
          status: "gone",
        });
        const preview = await handleWorkDraftPreviewRequest(deps, {
          ...scope,
          documentId: chapter,
          itemKey: wrong,
        });
        expect(preview.status).toBe("gone");
        const discard = await handleDiscardWorkDraftRequest(deps, {
          ...scope,
          documentId: chapter,
          request: { draftId: mine.draftId, itemKey: wrong, commandId: randomUUID() },
        });
        expect(discard.body).toMatchObject({ status: "gone" });
        await expect(
          handleApplyWorkDraftRequest(deps, {
            ...scope,
            documentId: chapter,
            request: { draftId: mine.draftId, itemKey: wrong, commandId: randomUUID() },
          }),
        ).rejects.toMatchObject({ statusCode: 404 });
      }
      // Nothing was done to the item the wrong keys named.
      expect((await s.items(work)).map((item) => item.itemKey)).toEqual([mine.itemKey]);
      expect(await s.draftStatuses(work)).toEqual(["active"]);
    });
    it("a document's draft hints list every other Work's active draft with changes to it, and drop settled or deleted ones", async () => {
      const { runtime, s } = await start();
      const deps = selectDraftRouteServices(runtime.app);
      const hints = async (documentId: DocumentId) =>
        (
          await handleDocumentDraftHintsRequest(deps, {
            projectId: s.project.id,
            documentId,
            userId: s.project.userId,
          })
        ).items;
      const northern = await s.work("Northern Arc", "draft");
      const rival = await s.work("Rival", "draft");
      const doomed = await s.work("Doomed", "draft");
      const chapter = await s.writer.createDocument("chapter.md", "Opening.");
      const untouched = await s.writer.createDocument("untouched.md", "Quiet.");
      for (const work of [northern, rival, doomed]) {
        await s.model(work).edit("chapter.md", "Opening.", `Opening by ${work.id}.`);
      }
      const all = await hints(chapter);
      expect(all.map((hint) => [hint.label, hint.originWorkId])).toEqual([
        ["Northern Arc", northern.id],
        ["Rival", rival.id],
        ["Doomed", doomed.id],
      ]);
      expect(all[0]?.itemKey).toBe((await s.items(northern))[0]?.itemKey);
      expect(await hints(untouched)).toEqual([]);
      await runtime.ports.workRepo.softDelete(doomed.id);
      await s.discard(rival, "all");
      expect((await hints(chapter)).map((hint) => hint.originWorkId)).toEqual([northern.id]);
      await s.apply(northern, [chapter], { tokens: "none" });
      expect(await hints(chapter)).toEqual([]);
    });
  });
});

__mergedSuite("draft-tree.preview.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/draft-tree.preview.db.test.ts.
  describeDraftTreeDb("deleted-live review preview", (start, db) => {
    it("projects and previews creates and edits in every drafted source", async () => {
      const { s, runtime } = await start();
      const work = await s.work("review-sources", "draft");
      for (const scheme of CONTEXT_URI_SCHEMES.filter(isDrafted)) {
        const prefix = `${scheme}://`;
        const existing = await s.writer.createDocument(`${prefix}Existing`, "Live words.");
        const created = await s.model(work).create(`${prefix}New`, "New words.");
        await s.model(work).edit(`${prefix}Existing`, "Live words.", "Edited words.");
        const review = await s.review(work);
        for (const [documentId, path, text, isNewDocument] of [
          [created, "/New", "New words.", true],
          [existing, "/Existing", "Edited words.", false],
        ] as const) {
          const row = review.items.find((item) => item.documentId === documentId);
          expect(row).toMatchObject({
            contextLocation: { scheme, path },
            isNew: isNewDocument,
          });
          if (!row) throw new Error("Expected a review row");
          const preview = await handleWorkDraftPreviewRequest(
            selectDraftRouteServices(runtime.app),
            {
              projectId: s.project.id,
              userId: s.project.userId,
              workId: work.id,
              documentId,
              itemKey: row.itemKey,
            },
          );
          expect(preview.status).toBe("active");
          expect(preview.status === "active" && preview.item.isNew).toBe(isNewDocument);
          expect(await s.view(work).text(`${prefix}${path.slice(1)}`)).toContain(text);
        }
      }
    });
    it("refuses a deleted Work's draft routes without provisioning, then restores its pending item", async () => {
      const { s, runtime } = await start();
      const work = await s.work("ascension", "draft");
      const documentId = await s.writer.createDocument("chapter.md", "Live words.");
      await s.model(work).edit("chapter.md", "Live words.", "Pending words.");
      const deps = selectDraftRouteServices(runtime.app);
      const input = { projectId: s.project.id, userId: s.project.userId, workId: work.id };
      const listed = await handleWorkDraftListRequest(deps, input);
      expect(listed.items).toHaveLength(1);
      const item = listed.items[0];
      if (!item?.branchGeneration) throw new Error("Expected a pending draft branch");
      const documentInput = { ...input, documentId, itemKey: item.itemKey };
      const body = {
        draftId: item.draftId,
        itemKey: item.itemKey,
        commandId: randomUUID(),
      };
      await deleteWorkTransition(
        { works: runtime.app.workRepo, stopThreadRun: runtime.app.stopThreadRun },
        work.id,
      );
      // Identity snapshots detect provisioning even if a read creates an empty branch.
      const rows = async () => ({
        drafts: await db.select({ id: drafts.id }).from(drafts).orderBy(drafts.id),
        branches: await db
          .select({ id: documentBranches.id })
          .from(documentBranches)
          .orderBy(documentBranches.id),
      });
      const deletedRows = await rows();
      await expect(handleWorkDraftListRequest(deps, input)).rejects.toMatchObject({
        statusCode: 404,
        message: "Draft not found",
      });
      expect(await rows()).toEqual(deletedRows);
      for (const request of [
        () => handleWorkDraftPreviewRequest(deps, documentInput),
        () => handleApplyWorkDraftRequest(deps, { ...input, documentId, request: body }),
        () => handleDiscardWorkDraftRequest(deps, { ...input, documentId, request: body }),
        () =>
          handleApplyAllWorkDraftRequest(deps, {
            ...input,
            request: {
              draftId: item.draftId,
              commandId: randomUUID() as never,
              items: [{ itemKey: item.itemKey, locationToken: item.tokens.locationToken }],
            },
          }),
        () =>
          handleDiscardAllWorkDraftRequest(deps, {
            ...input,
            request: { draftId: item.draftId, commandId: randomUUID() as never },
          }),
      ]) {
        await expect(request()).rejects.toMatchObject({
          statusCode: 404,
          message: "Draft not found",
        });
      }
      const restored = await restoreWork(
        { works: runtime.app.workRepo, workContextNotices: runtime.app.workContextNotices },
        work.id,
      );
      expect(restored.deletedAt).toBeNull();
      expect((await handleWorkDraftListRequest(deps, input)).items).toEqual(listed.items);
      const preview = await handleWorkDraftPreviewRequest(deps, documentInput);
      expect(preview.status).toBe("active");
      expect(await s.view(work).text("chapter.md")).toContain("Pending words.");
    });
    it("previews pending text, including archived read-only review, but refuses another Work's branch", async () => {
      const { s, runtime } = await start();
      const work = await s.work("ascension", "draft");
      const other = await s.work("beacon", "draft");
      const documentId = await s.writer.createDocument("chapter.md", "Live words.");
      await s.model(work).edit("chapter.md", "Live words.", "Pending words.");
      await s.model(other).edit("chapter.md", "Live words.", "Other words.");
      const [item] = await s.items(work);
      const [foreign] = await s.items(other);
      if (!item || !foreign) throw new Error("Expected both Works to have an item");
      expect((await s.writer.delete("chapter.md")).ok).toBe(true);
      expect((await s.items(work))[0]?.conflict?.code).toBe("deleted_live");
      const deps = selectDraftRouteServices(runtime.app);
      const input = {
        projectId: s.project.id,
        userId: s.project.userId,
        workId: work.id,
        documentId,
        itemKey: item.itemKey,
      };
      const preview = await handleWorkDraftPreviewRequest(deps, input);
      expect(preview.status).toBe("active");
      expect(JSON.stringify(preview.status === "active" ? preview.hunks : null)).toContain(
        "Pending",
      );
      // Another Work's key names nothing here.
      expect(
        await handleWorkDraftPreviewRequest(deps, {
          ...input,
          itemKey: foreign.itemKey,
        }),
      ).toMatchObject({ status: "gone" });
      await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, work.id));
      expect((await handleWorkDraftPreviewRequest(deps, input)).status).toBe("active");
      await expect(
        handleApplyWorkDraftRequest(deps, {
          ...input,
          request: {
            draftId: item.draftId,
            itemKey: item.itemKey,
            commandId: randomUUID(),
          },
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      for (const target of [
        { kind: "document" as const, documentId },
        { kind: "draft" as const, documentId, workId: work.id },
      ]) {
        expect(
          await runtime.app.fileAccess.authorize({ accountId: s.project.userId }, target, "read"),
        ).toMatchObject({ denied: true, reason: "not_found" });
      }
    });
  });
});

__mergedSuite("document-address.review.db.test.ts", () => {
  // Merged from apps/server/server/domains/context/document-address.review.db.test.ts.
  describeDraftTreeDb("review address identity", (start, db) => {
    it("selects the hidden KB draft at a live collision and refuses invalid capabilities", async () => {
      const { s, runtime } = await start();
      const work = await s.work("review-binding", "draft");
      const hidden = await s.model(work).create("kb://Withern", "MODEL DRAFT words.");
      const live = await s.seedLive("kb://Withern");
      expect(live).not.toBe(hidden);
      const [unusedRow] = await db
        .insert(documents)
        .values({
          contextSourceId: s.project.sources.kb,
          name: "Unused",
          extension: "",
          hidden: true,
        })
        .returning({ id: documents.id });
      if (!unusedRow) throw new Error("Expected an orphan hidden document");
      const unused = unusedRow.id;
      const row = (await s.items(work)).find((item) => item.documentId === hidden);
      if (!row) throw new Error("Expected draft item");
      const { branchId } = await s.draftBranch(work, hidden);
      const rival = await s.work("rival", "draft");
      await s.model(rival).create("kb://Rival", "Rival words.");
      const [rivalItem] = await s.items(rival);
      const input = {
        projectId: s.project.id,
        userId: s.project.userId,
        scheme: "kb" as const,
        workId: null,
        path: "Withern",
      };
      const review = { workId: work.id, itemKey: row.itemKey };
      const deps = { ...runtime.app, draftReview: runtime.app.documentSync.draftReview };
      await expect(handleDocumentAddressRequest(deps, input, review)).resolves.toMatchObject({
        kind: "current",
        document: { documentId: hidden, entry: { uri: "kb://Withern" } },
      });
      await expect(handleDocumentAddressRequest(deps, input)).resolves.toMatchObject({
        kind: "current",
        document: { documentId: live },
      });
      await expect(
        handleDocumentAddressRequest(deps, { ...input, path: "Old name" }, review),
      ).resolves.toMatchObject({
        kind: "current",
        document: { documentId: hidden, entry: { uri: "kb://Withern" } },
      });
      for (const selector of [
        { ...review, itemKey: "bad" },
        { ...review, workId: rival.id },
        { ...review, itemKey: branchId },
        { ...review, itemKey: row.draftId },
        { ...review, itemKey: rivalItem?.itemKey ?? "missing" },
        { ...review, itemKey: `${row.draftId}:${live}` },
        { ...review, itemKey: `${row.draftId}:${unused}` },
      ]) {
        expect(
          await handleDocumentAddressRequest(deps, input, selector),
          JSON.stringify(selector),
        ).toEqual({
          kind: "unavailable",
        });
      }
      const other = await s.another("project");
      await expect(
        handleDocumentAddressRequest(deps, { ...input, projectId: other.project.id }, review),
      ).resolves.toEqual({ kind: "unavailable" });
      await deps.workRepo.archive(work.id);
      await expect(handleDocumentAddressRequest(deps, input, review)).resolves.toMatchObject({
        kind: "current",
        document: { documentId: hidden },
      });
      await expect(
        deps.fileAccess.authorizeAt(
          { accountId: s.project.userId },
          { kind: "document", documentId: hidden },
          { kind: "draft", workId: work.id, workSlug: work.slug },
          "edit",
        ),
      ).resolves.toMatchObject({ denied: true, reason: "work_archived" });
      const stranger = await s.another("account");
      await expect(
        handleDocumentAddressRequest(deps, { ...input, userId: stranger.project.userId }, review),
      ).resolves.toEqual({ kind: "unavailable" });
    });
  });
});
