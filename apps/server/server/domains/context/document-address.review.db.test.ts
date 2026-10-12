/** Real draft tree and file policy keep colliding browser addresses identity-bound. */
import { documents } from "@meridian/database/schema";
import { expect, it } from "vitest";
import { handleDocumentAddressRequest } from "../../lib/document-address-route.js";
import { describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";

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
    const row = (await s.review(work)).drafts.find((draft) => draft.documentId === hidden);
    if (!row) throw new Error("Expected draft branch");
    const input = {
      projectId: s.project.id,
      userId: s.project.userId,
      scheme: "kb" as const,
      workId: null,
      path: "Withern",
    };
    const review = { workId: work.id, draftBranchId: row.draftId, documentId: hidden };
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
      { ...review, draftBranchId: "bad" },
      { ...review, workId: (await s.work("rival", "draft")).id },
      { ...review, documentId: live },
      { ...review, documentId: unused },
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
