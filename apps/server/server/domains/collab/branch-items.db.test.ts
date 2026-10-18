/**
 * Contract §3.6 DB cases: whole-item rows (a create with no branch) and the §1.2 identity
 * rule: an item is named by its `itemKey` alone, never by a draft id or a branch id.
 */
import { randomUUID } from "node:crypto";
import type { DocumentId } from "@meridian/contracts";
import { expect, it } from "vitest";
import {
  handleApplyWorkDraftChangesRequest,
  handleApplyWorkDraftRequest,
  handleDiscardWorkDraftRequest,
  handleDocumentDraftHintsRequest,
  handleWorkDraftPreviewRequest,
  selectBranchRouteServices,
} from "../../lib/branch-review-route.js";
import { describeBranchTreeDb } from "../../test-support/branch-tree-suite.js";

describeBranchTreeDb("review items (postgres)", (start) => {
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
    const deps = selectBranchRouteServices(runtime.app);
    const scope = { projectId: s.project.id, workId: work.id, userId: s.project.userId };
    const keptItem = items.find((item) => item.documentId === kept);
    if (!keptItem) throw new Error("no kept item");
    const perChange = await handleApplyWorkDraftChangesRequest(deps, {
      ...scope,
      documentId: kept,
      request: {
        branchId: keptItem.branchId,
        itemKey: keptItem.itemKey,
        commandId: randomUUID(),
        operationIds: ["1"],
        liveRevisionToken: "x",
        draftRevisionToken: "x",
      },
    });
    expect(perChange.body).toMatchObject({ status: "whole_item" });

    // Item Discard of one created item leaves the other and the draft active.
    const [discarded] = (await s.discard(work, [dropped])) as { status: string }[];
    expect(discarded).toMatchObject({ status: "discarded" });
    expect((await s.items(work)).map((item) => item.documentId)).toEqual([kept]);
    expect(await s.branchStatuses(work)).toEqual(["active"]);
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
    const { draftId: documentDraft } = await s.documentDraft(work, chapter);
    const deps = selectBranchRouteServices(runtime.app);
    const scope = { projectId: s.project.id, workId: work.id, userId: s.project.userId };
    const review = runtime.ports.documentSync.draftReview;
    for (const wrong of [mine.branchId, documentDraft, theirs.itemKey]) {
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
        request: { branchId: mine.branchId, itemKey: wrong, commandId: randomUUID() },
      });
      expect(discard.body).toMatchObject({ status: "gone" });
      await expect(
        handleApplyWorkDraftRequest(deps, {
          ...scope,
          documentId: chapter,
          request: { branchId: mine.branchId, itemKey: wrong, commandId: randomUUID() },
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
    // Nothing was done to the item the wrong keys named.
    expect((await s.items(work)).map((item) => item.itemKey)).toEqual([mine.itemKey]);
    expect(await s.branchStatuses(work)).toEqual(["active"]);
  });

  it("a document's draft hints list every other Work's active draft with changes to it, and drop settled or deleted ones", async () => {
    const { runtime, s } = await start();
    const deps = selectBranchRouteServices(runtime.app);
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
