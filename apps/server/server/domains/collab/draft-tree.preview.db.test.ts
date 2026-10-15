/** Draft review respects Work lifecycle while preserving pending items through restore. */

import { randomUUID } from "node:crypto";
import { CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import { documentBranches, drafts, works } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  handleApplyAllWorkDraftRequest,
  handleApplyWorkDraftRequest,
  handleDiscardAllWorkDraftRequest,
  handleDiscardWorkDraftRequest,
  handleWorkDraftListRequest,
  handleWorkDraftPreviewRequest,
  selectDraftRouteServices,
} from "../../lib/draft-review-route.js";
import { describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";
import { isDrafted } from "../file-policy/index.js";
import { deleteWorkTransition, restoreWork } from "../projects/index.js";

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
        expect(row).toMatchObject({ contextLocation: { scheme, path }, isNew: isNewDocument });
        if (!row) throw new Error("Expected a review row");
        const preview = await handleWorkDraftPreviewRequest(selectDraftRouteServices(runtime.app), {
          projectId: s.project.id,
          userId: s.project.userId,
          workId: work.id,
          documentId,
          itemKey: row.itemKey,
        });
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
    const body = { draftId: item.draftId, itemKey: item.itemKey, commandId: randomUUID() };
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
    expect(JSON.stringify(preview.status === "active" ? preview.hunks : null)).toContain("Pending");
    // Another Work's key names nothing here.
    expect(
      await handleWorkDraftPreviewRequest(deps, { ...input, itemKey: foreign.itemKey }),
    ).toMatchObject({ status: "gone" });
    await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, work.id));
    expect((await handleWorkDraftPreviewRequest(deps, input)).status).toBe("active");
    await expect(
      handleApplyWorkDraftRequest(deps, {
        ...input,
        request: { draftId: item.draftId, itemKey: item.itemKey, commandId: randomUUID() },
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
