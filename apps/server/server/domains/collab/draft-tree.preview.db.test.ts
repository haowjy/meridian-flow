/** A deleted-live edit stays reviewable only through its own active draft. */

import { works } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  handleApplyWorkDraftRequest,
  handleWorkDraftPreviewRequest,
  selectDraftRouteServices,
} from "../../lib/draft-review-route.js";
import { describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";

describeDraftTreeDb("deleted-live review preview", (start, db) => {
  it("previews pending text, including archived read-only review, but refuses another Work's branch", async () => {
    const { s, runtime } = await start();
    const work = await s.work("ascension", "draft");
    const other = await s.work("beacon", "draft");
    const documentId = await s.writer.createDocument("chapter.md", "Live words.");
    await s.model(work).edit("chapter.md", "Live words.", "Pending words.");
    await s.model(other).edit("chapter.md", "Live words.", "Other words.");
    const branch = await s.draftBranch(work, documentId);
    const foreign = await s.draftBranch(other, documentId);
    expect((await s.writer.delete("chapter.md")).ok).toBe(true);
    expect((await s.items(work))[0]?.conflict?.code).toBe("deleted_live");
    const deps = selectDraftRouteServices(runtime.app);
    const input = {
      projectId: s.project.id,
      userId: s.project.userId,
      workId: work.id,
      documentId,
      draftId: branch.branchId,
    };
    const preview = await handleWorkDraftPreviewRequest(deps, input);
    expect(preview.status).toBe("active");
    if (preview.status === "active") expect(preview.preview).toContain("Pending words.");
    await expect(
      handleWorkDraftPreviewRequest(deps, { ...input, draftId: foreign.branchId }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, work.id));
    expect((await handleWorkDraftPreviewRequest(deps, input)).status).toBe("active");
    await expect(handleApplyWorkDraftRequest(deps, input)).rejects.toMatchObject({
      statusCode: 404,
    });
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
