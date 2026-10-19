/** Branch review respects Work lifecycle while preserving pending items through restore. */

import { randomUUID } from "node:crypto";
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { branches, documentDrafts } from "@meridian/database/schema";
import { expect, it } from "vitest";
import {
  handleApplyClickRequest,
  handleDiscardAllWorkBranchRequest,
  handleDiscardWorkDraftRequest,
  handleWorkBranchListRequest,
  handleWorkDraftPreviewRequest,
  selectBranchRouteServices,
} from "../../lib/branch-review-route.js";
import { describeBranchTreeDb } from "../../test-support/branch-tree-suite.js";
import { isDrafted } from "../file-policy/index.js";
import { deleteWorkTransition, restoreWork } from "../projects/index.js";

describeBranchTreeDb("deleted-live review preview", (start, db) => {
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
        expect(row).toMatchObject({ contextLocation: { scheme, path }, isNew: isNewDocument });
        if (!row) throw new Error("Expected a review row");
        const preview = await handleWorkDraftPreviewRequest(
          selectBranchRouteServices(runtime.app),
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

  it("refuses a deleted Work's branch routes without provisioning, then restores its pending item", async () => {
    const { s, runtime } = await start();
    const work = await s.work("ascension", "draft");
    const documentId = await s.writer.createDocument("chapter.md", "Live words.");
    await s.model(work).edit("chapter.md", "Live words.", "Pending words.");
    const deps = selectBranchRouteServices(runtime.app);
    const input = { projectId: s.project.id, userId: s.project.userId, workId: work.id };
    const listed = await handleWorkBranchListRequest(deps, input);
    expect(listed.items).toHaveLength(1);
    const item = listed.items[0];
    if (!item?.draftGeneration) throw new Error("Expected a pending draft");
    const documentInput = { ...input, documentId, itemKey: item.itemKey };
    const body = { branchId: item.branchId, itemKey: item.itemKey, commandId: randomUUID() };
    await deleteWorkTransition(
      { works: runtime.app.workRepo, stopThreadRun: runtime.app.stopThreadRun },
      work.id,
    );
    // Identity snapshots detect provisioning even if a read creates an empty branch.
    const rows = async () => ({
      branches: await db.select({ id: branches.id }).from(branches).orderBy(branches.id),
      drafts: await db
        .select({ id: documentDrafts.id })
        .from(documentDrafts)
        .orderBy(documentDrafts.id),
    });
    const deletedRows = await rows();
    await expect(handleWorkBranchListRequest(deps, input)).rejects.toMatchObject({
      statusCode: 404,
      message: "Work not found",
    });
    expect(await rows()).toEqual(deletedRows);
    for (const request of [
      () => handleWorkDraftPreviewRequest(deps, documentInput),
      () => handleApplyClickRequest(deps, { ...input, documentId, request: body }),
      () => handleDiscardWorkDraftRequest(deps, { ...input, documentId, request: body }),
      () =>
        handleDiscardAllWorkBranchRequest(deps, {
          ...input,
          request: { branchId: item.branchId, commandId: randomUUID() as never },
        }),
    ]) {
      await expect(request()).rejects.toMatchObject({
        statusCode: 404,
        message: "Work not found",
      });
    }
    const restored = await restoreWork(
      { works: runtime.app.workRepo, workContextNotices: runtime.app.workContextNotices },
      work.id,
    );
    expect(restored.deletedAt).toBeNull();
    expect((await handleWorkBranchListRequest(deps, input)).items).toEqual(listed.items);
    const preview = await handleWorkDraftPreviewRequest(deps, documentInput);
    expect(preview.status).toBe("active");
    expect(await s.view(work).text("chapter.md")).toContain("Pending words.");
  });
});
