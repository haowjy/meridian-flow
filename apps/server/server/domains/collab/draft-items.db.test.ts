/**
 * Contract §3.6 DB cases: whole-item rows (a create with no branch) and the §1.2 identity
 * rule: an item is named by its `itemKey` alone, never by a draft id or a branch id.
 */
import { randomUUID } from "node:crypto";
import type { DocumentId } from "@meridian/contracts";
import { expect, it } from "vitest";
import type * as Y from "yjs";
import {
  handleApplyWorkDraftChangesRequest,
  handleApplyWorkDraftRequest,
  handleDiscardWorkDraftRequest,
  handleDocumentDraftHintsRequest,
  handleDraftAttributionRequest,
  handleWorkDraftItemMetaRequest,
  selectDraftRouteServices,
} from "../../lib/draft-review-route.js";
import { describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";
import { createDrizzleWorkDraftPendingStore } from "./adapters/drizzle-branch-push.js";

describeDraftTreeDb("review items (postgres)", (start, db) => {
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
        changeIds: ["1"],
        snapshot: "x",
      },
    });
    expect(perChange.body).toMatchObject({ status: "whole_item" });

    // Item Discard of one created item leaves the other and the draft active.
    const [discarded] = (await s.discard(work, [dropped])) as { status: string }[];
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
      expect(await review.itemMeta({ workId: work.id, itemKey: wrong })).toMatchObject({
        status: "gone",
      });
      await expect(
        handleWorkDraftItemMetaRequest(deps, { ...scope, documentId: chapter, itemKey: wrong }),
      ).rejects.toMatchObject({ statusCode: 404 });
      const discard = await handleDiscardWorkDraftRequest(deps, {
        ...scope,
        documentId: chapter,
        request: { draftId: mine.draftId, itemKey: wrong, commandId: randomUUID() },
      });
      expect(discard.body).toMatchObject({ status: "gone" });
      // The 404 carries the outcome JSON observation returns (§1.2).
      await expect(
        handleApplyWorkDraftRequest(deps, {
          ...scope,
          documentId: chapter,
          request: { draftId: mine.draftId, itemKey: wrong, commandId: randomUUID() },
        }),
      ).resolves.toEqual({
        httpStatus: 404,
        body: { status: "gone", draftId: mine.draftId, itemKey: wrong },
      });
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

  it("the review list, the catalog count and the document hints read one item relation", async () => {
    const { runtime, s } = await start();
    const work = await s.work("Ascension", "draft");
    const chapter = await s.writer.createDocument("chapter.md", "Opening.");
    const scene = await s.writer.createDocument("scene.md", "Quiet.");
    const lost = await s.writer.createDocument("lost.md", "Gone.");
    await s.writer.createDocument("quiet.md", "Untouched.");
    await s.model(work).edit("chapter.md", "Opening.", "Opening, drafted.");
    await s.model(work).edit("scene.md", "Quiet.", "Quiet, drafted.");
    await s.model(work).edit("lost.md", "Gone.", "Gone, drafted.");
    const blank = await s
      .model(work)
      .now("write", { command: "create", path: "manuscript://notes/blank.md" });
    expect(blank.isError).not.toBe(true);
    const deps = selectDraftRouteServices(runtime.app);
    // Every consumer of the relation, read at once: the list, the Work's count, the relation's own
    // drafts for each item and the route's hint. A created document has no live file for the route's
    // read grant to open, so its route hint is exactly empty while the relation still names its draft.
    const consumers = async () => {
      const store = createDrizzleWorkDraftPendingStore(db);
      const listed = await s.items(work);
      const counts = await store.countPendingByWorkIds([work.id]);
      expect(counts.get(work.id) ?? 0).toBe(listed.length);
      for (const item of listed) {
        const documentId = item.documentId as DocumentId;
        const related = await store.listDraftsChangingDocument({
          projectId: s.project.id,
          documentId,
        });
        expect(related.map((draft) => draft.draftId)).toEqual([item.draftId]);
        const { items } = await handleDocumentDraftHintsRequest(deps, {
          projectId: s.project.id,
          documentId,
          userId: s.project.userId,
        });
        expect(items.map((hint) => hint.itemKey)).toEqual(item.wholeItem ? [] : [item.itemKey]);
      }
      return listed.map((item) => item.documentId).sort();
    };
    expect(await consumers()).toEqual(
      [(await s.view(work).idAt("notes/blank.md")) as DocumentId, chapter, scene, lost].sort(),
    );

    // An AI edit the writer discards locally to empty leaves the relation, and no other arm moves.
    await s.writer.editDraft(work, scene, (doc) => {
      const text = (doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
      text.delete("Quiet".length, ", drafted".length);
    });
    expect(await consumers()).not.toContain(scene);
    // A live delete under a drafted edit leaves the item to the relation's rule, the same for all three.
    await s.writer.delete("lost.md");
    await consumers();

    // The last change Applied through the route empties the item for every consumer at once.
    const [applied] = await s.apply(work, [chapter], { tokens: "rendered" });
    expect(applied?.body).toMatchObject({ status: "applied", hasChanges: false });
    expect(await consumers()).not.toContain(chapter);
  });

  it("the chat-name hint lists the item's pending AI edits, and an unknown item is gone", async () => {
    const { runtime, s } = await start();
    const work = await s.work("Ascension", "draft");
    const chapter = await s.writer.createDocument("chapter.md", "Opening.");
    await s.model(work).edit("chapter.md", "Opening.", "Opening, drafted.");
    const deps = selectDraftRouteServices(runtime.app);
    const scope = { projectId: s.project.id, workId: work.id, userId: s.project.userId };
    const [item] = await s.items(work);
    if (!item) throw new Error("no item");
    const hint = await handleDraftAttributionRequest(deps, {
      ...scope,
      documentId: chapter,
      itemKey: item.itemKey,
    });
    expect(hint.itemKey).toBe(item.itemKey);
    expect(hint.edits).toHaveLength(1);
    expect(hint.edits[0]?.inserted.length).toBeGreaterThan(0);
    await expect(
      handleDraftAttributionRequest(deps, { ...scope, documentId: chapter, itemKey: "nope" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
