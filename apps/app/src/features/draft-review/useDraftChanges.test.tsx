// @vitest-environment jsdom
/**
 * A change list of any draft of a Work: an unopened draft lists and applies its
 * changes while another stays in review, a draft of a Work no other scope has
 * does it without joining a review room, and a write or disposition from
 * elsewhere reaches a mounted list through the draft's list row. Real provider,
 * controllers, mutations and query cache; the network is the only fake.
 */

import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  applied,
  listed,
  previewOf,
  renderReviewScopes,
  type ScopeProbe,
} from "@/test-support/draft-review-scope";
import type { DraftChangesView } from "./draft-changes";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  applyDraftChanges: vi.fn(),
  discardDraft: vi.fn(),
  retainBranchRooms: vi.fn(),
}));

vi.mock("@/client/api/drafts-api", () => mocks);
vi.mock("@/client/query/useContextCatalog", () => ({
  contextCatalogScope: () => ({ kind: "project", projectId: "project-a" }),
  useContextCatalogView: () => ({ catalog: null }),
  projectCatalogView: () => ({ findDocument: () => null }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({ promoteAppliedDraft: vi.fn(), discardDraft: vi.fn() }),
  useOptionalAccountResourceReplica: () => null,
  useLiveDocumentSessionRegistry: () => ({
    retainBranchRooms: mocks.retainBranchRooms,
    releaseBranchRooms: vi.fn(),
    getBranchRoom: () => ({ document: { on: vi.fn(), off: vi.fn() } }),
  }),
}));

const draftB = { draftId: "draft-b", documentId: "document-b" };
const listedB = { ...listed, ...draftB, documentName: "Chapter 13" };
const targetOf = (workId: string, draft: { draftId: string; documentId: string }) => ({
  projectId: "project-a",
  workId,
  ...draft,
});
const targetB = targetOf("work-a", draftB);
const classIds = (view: DraftChangesView) => view.items.map((item) => item.change.classId);

/** Each draft reads its own preview; `previews` is what the server holds now. */
const previews: Record<string, ReturnType<typeof previewOf>> = {};
function serverHolds(draftId: string, ...ids: string[]) {
  previews[draftId] = { ...previewOf(...ids), draftId };
}

async function reviewOpened(probe: () => ScopeProbe) {
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
  await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
  await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
}

describe("useDraftChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    serverHolds("draft-a", "1", "2");
    serverHolds("draft-b", "7", "8");
    serverHolds("draft-c", "9");
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed, listedB] });
    mocks.getDraftPreview.mockImplementation(
      async (_project: string, _work: string, _document: string, draftId: string) =>
        previews[draftId],
    );
  });

  it("lists and applies an unopened draft's change while another draft stays in review", async () => {
    mocks.applyDraftChanges.mockResolvedValue({
      ...applied(false, "7"),
      draftId: "draft-b",
      closureClassIds: ["class-7"],
    });
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      const view = await probe().mountDraftChanges(targetB);
      await vi.waitFor(() => expect(view().status).toBe("ready"));
      expect(classIds(view())).toEqual(["class-7", "class-8"]);
      expect(view().focused).toBeNull();

      await act(async () => {
        await view().apply(view().items[0].change);
      });
      // The command went out for B with B's tokens, and the change left at once.
      expect(mocks.applyDraftChanges).toHaveBeenCalledWith(
        "project-a",
        "work-a",
        "document-b",
        expect.objectContaining({ draftId: "draft-b", operationIds: ["7"] }),
      );
      expect(classIds(view())).toEqual(["class-8"]);
      // A is still the open review, untouched.
      expect(probe().editor.controller.inlineReview).toMatchObject({ draftId: "draft-a" });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(probe().header.view.items).toHaveLength(2);
    });
  });

  it("applies the last change of the open review through the Editor's controller", async () => {
    serverHolds("draft-a", "2");
    let answer!: (response: unknown) => void;
    mocks.applyDraftChanges.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      // Listed from the Chat's scope, the open review's rows are the Editor's own.
      const view = await probe().mountDraftChanges(targetOf("work-a", draftA()));
      await vi.waitFor(() => expect(view().status).toBe("ready"));
      let done: Promise<unknown> | undefined;
      await act(async () => {
        done = view().apply(view().items[0].change);
      });
      expect(probe().header.completing).toBe("apply");
      await act(async () => {
        answer(applied(true));
        await done;
      });
      expect(probe().header.finished).toBe(true);
    });
  });

  it("lists and applies a draft of a Work no other scope has, without joining a review room", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [{ ...listed, draftId: "draft-c", documentId: "document-c" }],
    });
    mocks.applyDraftChanges.mockResolvedValue({
      ...applied(true, "9"),
      draftId: "draft-c",
      closureClassIds: ["class-9"],
    });
    await renderReviewScopes(async (probe) => {
      await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
      const view = await probe().mountDraftChanges(
        targetOf("work-c", { draftId: "draft-c", documentId: "document-c" }),
        "third",
      );
      await vi.waitFor(() => expect(view().status).toBe("ready"));
      expect(classIds(view())).toEqual(["class-9"]);

      await act(async () => {
        await view().apply(view().items[0].change);
      });
      expect(mocks.applyDraftChanges).toHaveBeenCalledWith(
        "project-a",
        "work-c",
        "document-c",
        expect.objectContaining({ draftId: "draft-c", operationIds: ["9"] }),
      );
      expect(classIds(view())).toEqual([]);
      // Listing and commanding is all the third scope does: no review, no room.
      expect(probe().third.controller.inlineReview).toBeNull();
      expect(probe().third.controller.reviewRoomName).toBeNull();
      expect(mocks.retainBranchRooms).not.toHaveBeenCalled();
    });
  });

  it("follows a remote write and a remote disposition through the draft's list row", async () => {
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      const view = await probe().mountDraftChanges(targetB);
      await vi.waitFor(() => expect(view().status).toBe("ready"));
      expect(classIds(view())).toEqual(["class-7", "class-8"]);
      const reads = () =>
        mocks.getDraftPreview.mock.calls.filter(([, , , draftId]) => draftId === "draft-b").length;
      const listChanged = async (updatedAt: string) => {
        mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed, { ...listedB, updatedAt }] });
        await act(async () =>
          probe().queryClient.invalidateQueries({
            queryKey: projectQueryKeys.workDrafts("project-a", "work-a"),
          }),
        );
      };

      // The catalog wake re-reads the list; the row did not change, so nothing is read again.
      const before = reads();
      await listChanged(listedB.updatedAt);
      expect(reads()).toBe(before);

      // The AI wrote: the row's updatedAt moves and the preview is read again.
      serverHolds("draft-b", "7", "8", "9");
      await listChanged("2026-10-08T00:00:01.000Z");
      await vi.waitFor(() => expect(classIds(view())).toEqual(["class-7", "class-8", "class-9"]));

      // A peer applied one of them.
      serverHolds("draft-b", "8", "9");
      await listChanged("2026-10-08T00:00:02.000Z");
      await vi.waitFor(() => expect(classIds(view())).toEqual(["class-8", "class-9"]));
    });
  });

  it("says the preview failed, with Retry, rather than listing no changes", async () => {
    mocks.getDraftPreview.mockImplementation(
      async (_project: string, _work: string, _document: string, draftId: string) => {
        if (draftId === "draft-b") throw new Error("unreachable");
        return previews[draftId];
      },
    );
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      const view = await probe().mountDraftChanges(targetB);
      await vi.waitFor(() => expect(view().status).toBe("error"));
      expect(view().items).toEqual([]);

      mocks.getDraftPreview.mockImplementation(async () => previews["draft-b"]);
      await act(async () => view().retry?.());
      await vi.waitFor(() => expect(view().status).toBe("ready"));
      expect(classIds(view())).toEqual(["class-7", "class-8"]);
    });
  });
});

function draftA() {
  return { draftId: "draft-a", documentId: "document-a" };
}
