// @vitest-environment jsdom
/**
 * The last change handled: what every surface says is the command's own answer,
 * never the optimistic projection's change count. Pending until the server
 * answers, closed when it says it closed the draft, carrying on when it did not.
 * Real provider, controller, mutations and query cache; the network is the only fake.
 */

import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  applied,
  change,
  discarded,
  draftA,
  listed,
  preview,
  previewOf,
  renderReviewScopes,
  type ScopeProbe,
} from "@/test-support/draft-review-scope";

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

const classIds = (probe: ScopeProbe) => probe.header.view.items.map((item) => item.change.classId);

async function reviewOpened(probe: () => ScopeProbe) {
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
  await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
  await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
}

/** The server closes the draft with the command: the list loses it before the answer reaches the controller. */
function serverClosesDraftWith<T>(answer: T): () => Promise<T> {
  return async () => {
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
    return answer;
  };
}

/** A command whose answer the test releases. */
function heldCommand(mock: typeof mocks.discardDraft) {
  let answer!: (response: unknown) => void;
  mock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  return (response: unknown) => answer(response);
}

describe("a review whose last change closes the draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
    mocks.getDraftPreview.mockResolvedValue(preview);
  });

  it("holds on No changes left when Apply closes the draft and the list drops it", async () => {
    mocks.applyDraftChanges.mockImplementation(serverClosesDraftWith(applied(true)));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        await probe().editor.controller.applyChanges(draftA, change("2"));
      });
      await act(async () => undefined);
      expect(probe().editor.controller.inlineReview?.completion).toEqual({
        phase: "closed",
        documentName: "Chapter 12",
      });
      expect(probe().header.finished).toBe(true);
      // The list no longer has the draft; the review does not follow it out.
      expect(probe().editor.groups).toEqual([]);
      expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-a");
    });
  });

  it("holds when Discard closes the draft, even though other changes still show in the cache", async () => {
    mocks.discardDraft.mockImplementation(serverClosesDraftWith(discarded(true)));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        await probe().editor.controller.discardChanges(draftA, change("2"));
      });
      await act(async () => undefined);
      expect(probe().editor.controller.inlineReview?.completion).toMatchObject({
        phase: "closed",
      });
      expect(probe().header.finished).toBe(true);
      expect(classIds(probe())).toEqual([]);
    });
  });
});

describe("the last change's command in flight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
    mocks.getDraftPreview.mockResolvedValue(previewOf("2"));
  });

  it("a last Apply shows the change gone but says Applying, not No changes left", async () => {
    const answer = heldCommand(mocks.applyDraftChanges);
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let done: Promise<unknown> | undefined;
      await act(async () => {
        done = probe().editor.controller.applyChanges(draftA, change("2"));
      });
      // The optimistic row is gone; nothing is finished.
      expect(classIds(probe())).toEqual([]);
      expect(probe().header.completing).toBe("apply");
      expect(probe().header.finished).toBe(false);
      expect(probe().editor.controller.inlineReview?.completion).toMatchObject({
        phase: "pending",
        mode: "apply",
      });
      expect(probe().editor.controller.isDisposing).toBe(true);

      await act(async () => {
        answer(applied(true));
        await done;
      });
      expect(probe().header.completing).toBeNull();
      expect(probe().header.finished).toBe(true);
      expect(probe().editor.controller.inlineReview?.completion?.phase).toBe("closed");
    });
  });

  it("a last Discard holds pending at the click, then closed on the answer", async () => {
    const answer = heldCommand(mocks.discardDraft);
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let done: Promise<unknown> | undefined;
      await act(async () => {
        done = probe().editor.controller.discardChanges(draftA, change("2"));
      });
      expect(probe().editor.controller.inlineReview?.completion).toEqual({
        phase: "pending",
        mode: "discard",
        documentName: "Chapter 12",
      });
      expect(probe().header.finished).toBe(false);
      expect(probe().header.completing).toBe("discard");
      await act(async () => {
        answer(discarded(true));
        await done;
      });
      expect(probe().editor.controller.inlineReview?.completion?.phase).toBe("closed");
      expect(probe().header.finished).toBe(true);
    });
  });

  it("a last Discard answered with the draft still open restores the review, with the change that arrived", async () => {
    const answer = heldCommand(mocks.discardDraft);
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let done: Promise<unknown> | undefined;
      await act(async () => {
        done = probe().editor.controller.discardChanges(draftA, change("2"));
      });
      expect(probe().editor.controller.inlineReview?.completion?.phase).toBe("pending");

      // Another change arrived while the command was in flight.
      mocks.getDraftPreview.mockResolvedValue(previewOf("3"));
      await act(async () => {
        answer(discarded(false));
        await done;
      });
      await vi.waitFor(() => expect(classIds(probe())).toEqual(["class-3"]));
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(probe().header.finished).toBe(false);
      expect(probe().header.completing).toBeNull();
      expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-a");
    });
  });

  it("a last Apply answered with the draft still open carries on, finished nowhere", async () => {
    mocks.applyDraftChanges.mockResolvedValue(applied(false));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      mocks.getDraftPreview.mockResolvedValue(previewOf("3"));
      await act(async () => {
        await probe().editor.controller.applyChanges(draftA, change("2"));
      });
      await vi.waitFor(() => expect(classIds(probe())).toEqual(["class-3"]));
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(probe().header.finished).toBe(false);
    });
  });

  it("brings the review back when the Discard does not land", async () => {
    mocks.discardDraft.mockRejectedValue(new Error("offline"));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        await probe().editor.controller.discardChanges(draftA, change("2"));
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(probe().header.finished).toBe(false);
      expect(classIds(probe())).toEqual(["class-2"]);
      expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-a");
    });
  });

  it("brings the review back when the Apply is refused", async () => {
    mocks.applyDraftChanges.mockResolvedValue({ status: "stale", draftId: "draft-a" });
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        await probe().editor.controller.applyChanges(draftA, change("2"));
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(classIds(probe())).toEqual(["class-2"]);
      expect(probe().header.view.items[0]?.failure).toMatchObject({ code: "stale" });
    });
  });

  it("does not predict a completion while another change is left", async () => {
    mocks.getDraftPreview.mockResolvedValue(preview);
    mocks.discardDraft.mockReturnValue(new Promise(() => undefined));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        void probe().editor.controller.discardChanges(draftA, change("2"));
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(probe().header.completing).toBeNull();
      expect(classIds(probe())).toEqual(["class-1"]);
    });
  });
});

describe("a selection sent from the Chat's scope to the Editor's open review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
    mocks.getDraftPreview.mockResolvedValue(previewOf("2"));
  });

  it("shows Applying at the click, then No changes left when the answer closes the draft", async () => {
    const answer = heldCommand(mocks.applyDraftChanges);
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let done: Promise<unknown> | undefined;
      await act(async () => {
        done = probe().chatRunner.applyBatch([{ draft: draftA, selection: change("2") }]);
      });
      // The review that owns the draft owns the pending state; the Chat's scope has none.
      expect(probe().header.completing).toBe("apply");
      expect(classIds(probe())).toEqual([]);
      expect(probe().chat.controller.inlineReview).toBeNull();

      await act(async () => {
        answer(applied(true));
        await done;
      });
      expect(probe().header.completing).toBeNull();
      expect(probe().header.finished).toBe(true);
      expect(probe().editor.controller.inlineReview?.completion).toMatchObject({
        phase: "closed",
      });
    });
  });

  it("says Discarding at the click and carries on when the draft stays open", async () => {
    const answer = heldCommand(mocks.discardDraft);
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let done: Promise<unknown> | undefined;
      await act(async () => {
        done = probe().chatRunner.discardChanges(draftA, change("2"));
      });
      expect(probe().header.completing).toBe("discard");

      mocks.getDraftPreview.mockResolvedValue(previewOf("3"));
      await act(async () => {
        answer(discarded(false));
        await done;
      });
      await vi.waitFor(() => expect(classIds(probe())).toEqual(["class-3"]));
      expect(probe().header.completing).toBeNull();
      expect(probe().header.finished).toBe(false);
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
    });
  });

  it("brings the change back with its reason when the server refuses", async () => {
    mocks.applyDraftChanges.mockResolvedValue({ status: "stale", draftId: "draft-a" });
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        await probe().chatRunner.applyChanges(draftA, change("2"));
      });
      expect(probe().header.completing).toBeNull();
      expect(classIds(probe())).toEqual(["class-2"]);
      expect(probe().header.view.items[0]?.failure).toMatchObject({ code: "stale" });
    });
  });

  it("leaves a review opened after the click alone when the answer arrives", async () => {
    const answer = heldCommand(mocks.applyDraftChanges);
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [listed, { ...listed, draftId: "draft-b", documentId: "document-b" }],
    });
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let done: Promise<unknown> | undefined;
      await act(async () => {
        done = probe().chatRunner.applyChanges(draftA, change("2"));
      });
      await act(async () => probe().editor.controller.enterInlineReview("document-b", "draft-b"));
      await act(async () => {
        answer(applied(true));
        await done;
      });
      expect(probe().editor.controller.inlineReview).toMatchObject({
        documentId: "document-b",
        draftId: "draft-b",
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
    });
  });
});
