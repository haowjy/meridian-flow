// @vitest-environment jsdom
/** The last change handled settles the review from the command's answer, before the closed draft leaves the list. */

import type { Work } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetChangeCommandRecords } from "@/client/query/change-command-record";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
  useDraftReviewScopeValue,
} from "./DraftReviewProvider";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  applyDraftChanges: vi.fn(),
  discardDraft: vi.fn(),
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
    retainBranchRooms: vi.fn(),
    releaseBranchRooms: vi.fn(),
    getBranchRoom: () => ({ document: { on: vi.fn(), off: vi.fn() } }),
  }),
}));

const work = { id: "work-a", projectId: "project-a", name: "Work A", archivedAt: null } as Work;
const listed = {
  draftId: "draft-a",
  documentId: "document-a",
  documentName: "Chapter 12",
  status: "active",
  lastActorTurnId: "turn-1",
  updatedAt: "2026-10-07T00:00:00.000Z",
};
const operation = (id: string) => ({
  operationId: id,
  closureClassId: `class-${id}`,
  kind: "agent",
  contribution: "added",
  classification: "addition",
  hunkCount: 1,
});
const preview = {
  status: "active",
  draftId: "draft-a",
  inlineModelPresent: true,
  reviewRoomName: "review-room-a",
  liveRevisionToken: "live-1",
  draftRevisionToken: "draft-1",
  operations: [operation("1"), operation("2")],
  hunks: [],
};
const change = (id: string) => ({ classId: `class-${id}`, operationIds: [id] });
const applied = (draftClosed: boolean) => ({
  status: "applied",
  draftId: "draft-a",
  operationIds: ["2"],
  closureClassIds: ["class-2"],
  draftClosed,
});

let review: DraftReviewContextValue | null = null;
function ReviewScope() {
  const value = useDraftReviewScopeValue({ projectId: "project-a", work });
  review = value;
  return <DraftReviewBoundary value={value}>{null}</DraftReviewBoundary>;
}

async function reviewOpened() {
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
  await act(async () => review?.controller.enterInlineReview("document-a", "draft-a"));
  await vi.waitFor(() => expect(mocks.getDraftPreview).toHaveBeenCalled());
  await act(async () => undefined);
}

/** The server closes the draft with the command: the list loses it before the answer reaches the controller. */
function serverClosesDraftWith<T>(answer: T): () => Promise<T> {
  return async () => {
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
    return answer;
  };
}

function renderScope(run: () => Promise<void>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return withReactRoot(
    <QueryClientProvider client={queryClient}>
      <ReviewScope />
    </QueryClientProvider>,
    run,
  );
}

describe("a review whose last change closes the draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChangeCommandRecords();
    review = null;
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
    mocks.getDraftPreview.mockResolvedValue(preview);
  });

  it("holds on No changes left when Apply closes the draft and the list drops it", async () => {
    mocks.applyDraftChanges.mockImplementation(serverClosesDraftWith(applied(true)));
    await renderScope(async () => {
      await reviewOpened();
      await act(async () => {
        await review?.controller.applyChange(change("2"));
      });
      await act(async () => undefined);
      expect(review?.controller.inlineReview?.cleared).toEqual({ documentName: "Chapter 12" });
      // The list no longer has the draft; the review does not follow it out.
      expect(review?.groups).toEqual([]);
      expect(review?.controller.inlineReview?.draftId).toBe("draft-a");
    });
  });

  it("holds when Discard closes the draft, even though other changes still show in the cache", async () => {
    mocks.discardDraft.mockImplementation(
      serverClosesDraftWith({ status: "discarded", draftId: "draft-a", draftClosed: true }),
    );
    await renderScope(async () => {
      await reviewOpened();
      await act(async () => {
        await review?.controller.discardChange(change("2"));
      });
      await act(async () => undefined);
      expect(review?.controller.inlineReview?.cleared).toEqual({ documentName: "Chapter 12" });
    });
  });

  describe("discarding the last change", () => {
    const oneChange = { ...preview, operations: [operation("2")] };

    it("settles at the click, before the server's reset reaches the review room", async () => {
      mocks.getDraftPreview.mockResolvedValue(oneChange);
      let answer!: (response: unknown) => void;
      mocks.discardDraft.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      await renderScope(async () => {
        await reviewOpened();
        let done: Promise<unknown> | undefined;
        await act(async () => {
          done = review?.controller.discardChange(change("2"));
        });
        expect(review?.controller.inlineReview?.cleared).toEqual({ documentName: "Chapter 12" });
        await act(async () => {
          answer({ status: "discarded", draftId: "draft-a", draftClosed: true });
          await done;
        });
        expect(review?.controller.inlineReview?.cleared).toBeDefined();
      });
    });

    it("brings the review back when the Discard does not land", async () => {
      mocks.getDraftPreview.mockResolvedValue(oneChange);
      mocks.discardDraft.mockRejectedValue(new Error("offline"));
      await renderScope(async () => {
        await reviewOpened();
        await act(async () => {
          await review?.controller.discardChange(change("2"));
        });
        expect(review?.controller.inlineReview?.cleared).toBeUndefined();
        expect(review?.controller.inlineReview?.draftId).toBe("draft-a");
      });
    });

    it("does not settle while another change is left", async () => {
      mocks.discardDraft.mockReturnValue(new Promise(() => undefined));
      await renderScope(async () => {
        await reviewOpened();
        await act(async () => {
          void review?.controller.discardChange(change("2"));
        });
        expect(review?.controller.inlineReview?.cleared).toBeUndefined();
      });
    });
  });

  it("stays unfinished while the server keeps the draft open", async () => {
    mocks.applyDraftChanges.mockResolvedValue(applied(false));
    await renderScope(async () => {
      await reviewOpened();
      await act(async () => {
        await review?.controller.applyChange(change("2"));
      });
      await act(async () => undefined);
      expect(review?.controller.inlineReview?.cleared).toBeUndefined();
      expect(review?.controller.inlineReview?.draftId).toBe("draft-a");
    });
  });
});
