// @vitest-environment jsdom
/**
 * A selection command belongs to its draft's claim, not to the controller that
 * sent it. Whoever has the draft open follows the command: a review opened
 * after the click adopts its pending completion, the answer settles the review
 * showing the draft, a refused duplicate never touches the first command's
 * hold, and a batch keeps the Work it began in. Real provider, controllers,
 * mutations and query cache; the network is the only fake.
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
  previewOf,
  renderReviewScopes,
  type ScopeProbe,
  workC,
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

const draftB = { documentId: "document-b", draftId: "draft-b" };
const listedB = { ...listed, ...draftB, documentName: "Chapter 13" };
const target = (draft: { documentId: string; draftId: string }) => ({
  projectId: "project-a",
  workId: "work-a",
  ...draft,
});
const answeredFor = (draft: { draftId: string }, answer: object) => ({ ...answer, ...draft });

/** Draft A holds changes 1 and 2, draft B only change 3. */
function twoDrafts() {
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed, listedB] });
  mocks.getDraftPreview.mockImplementation(async (_p, _w, _d, id: string) =>
    id === "draft-b" ? { ...previewOf("3"), draftId: "draft-b" } : previewOf("1", "2"),
  );
}

/** A command whose answer the test releases. */
function heldCommand(mock: typeof mocks.discardDraft) {
  let answer!: (response: unknown) => void;
  mock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  return (response: unknown) => answer(response);
}

async function groupsListed(probe: () => ScopeProbe) {
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
  await vi.waitFor(() => expect(probe().editor.groups).toHaveLength(2));
}

const open = (probe: () => ScopeProbe, draft: { documentId: string; draftId: string }) =>
  act(async () => probe().editor.controller.enterInlineReview(draft.documentId, draft.draftId));

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftCommandRecords();
  twoDrafts();
});

describe("a review opened on a draft whose last change another scope has sent", () => {
  /** The Chat sends the last Discard of unopened B, then the writer opens B before the answer. */
  async function sentThenOpened(
    probe: () => ScopeProbe,
    answer: (response: unknown) => void,
    send: () => Promise<unknown>,
  ) {
    await groupsListed(probe);
    await open(probe, draftA);
    const view = await probe().mountDraftChanges(target(draftB));
    await vi.waitFor(() => expect(view().status).toBe("ready"));
    let done!: Promise<unknown>;
    await act(async () => {
      done = send();
    });
    expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-a");
    await open(probe, draftB);
    return { view, done, answer };
  }

  it("adopts the pending completion and the Discard hold, then holds on No changes left when the draft closed", async () => {
    const answer = heldCommand(mocks.discardDraft);
    await renderReviewScopes(async (probe) => {
      const { done } = await sentThenOpened(probe, answer, () =>
        probe().chatRunner.discardChanges(draftB, change("3")),
      );
      expect(probe().editor.controller.inlineReview?.completion).toEqual({
        phase: "pending",
        mode: "discard",
        documentName: "Chapter 13",
      });

      // The server closes the draft with the command: the list loses it before the answer lands.
      mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
      mocks.getDraftPreview.mockImplementation(async (_p, _w, _d, id: string) =>
        id === "draft-b" ? { status: "gone" } : previewOf("1", "2"),
      );
      await act(async () => {
        answer(answeredFor(draftB, discarded(true)));
        await done;
      });
      await vi.waitFor(() => expect(probe().editor.groups).toHaveLength(1));
      expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-b");
      expect(probe().editor.controller.inlineReview?.completion).toEqual({
        phase: "closed",
        documentName: "Chapter 13",
      });
    });
  });

  it("carries on when the answer did not close the draft", async () => {
    const answer = heldCommand(mocks.applyDraftChanges);
    await renderReviewScopes(async (probe) => {
      const { done } = await sentThenOpened(probe, answer, () =>
        probe().chatRunner.applyChanges(draftB, change("3")),
      );
      expect(probe().editor.controller.inlineReview?.completion).toMatchObject({
        phase: "pending",
        mode: "apply",
      });

      await act(async () => {
        answer(answeredFor(draftB, applied(false, "3")));
        await done;
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-b");
    });
  });

  it("brings the review and the change back when the server refuses", async () => {
    const answer = heldCommand(mocks.discardDraft);
    await renderReviewScopes(async (probe) => {
      const { view, done } = await sentThenOpened(probe, answer, () =>
        probe().chatRunner.discardChanges(draftB, change("3")),
      );
      expect(probe().editor.controller.inlineReview?.completion?.phase).toBe("pending");
      expect(view().items).toEqual([]);

      await act(async () => {
        answer(answeredFor(draftB, { status: "stale" }));
        await done;
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(view().items.map((item) => item.change.classId)).toEqual(["class-3"]);
      expect(view().items[0]?.failure).toMatchObject({ code: "stale" });
    });
  });
});

describe("two last Discards for one open draft in the same turn", () => {
  it("keeps the first command's hold when the second is refused", async () => {
    mocks.getDraftPreview.mockResolvedValue(previewOf("2"));
    const answer = heldCommand(mocks.discardDraft);
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      await open(probe, draftA);
      await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
      let first!: Promise<unknown>;
      let second: unknown;
      await act(async () => {
        first = probe().chatRunner.discardChanges(draftA, change("2"));
        second = await probe().chatRunner.discardChanges(draftA, change("2"));
      });
      expect(second).toEqual({ kind: "blocked" });
      expect(probe().editor.controller.isDisposing).toBe(true);
      expect(probe().editor.controller.inlineReview?.completion).toMatchObject({
        phase: "pending",
        mode: "discard",
      });

      await act(async () => {
        answer(discarded(false));
        await first;
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
    });
  });
});

describe("an answer that arrives after the writer moved to another review", () => {
  it("shows no toast in the review they are in", async () => {
    const answer = heldCommand(mocks.applyDraftChanges);
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      await open(probe, draftA);
      await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
      let done!: Promise<unknown>;
      await act(async () => {
        done = probe().editor.controller.applyChanges(draftA, change("2"));
      });
      await open(probe, draftB);
      await act(async () => {
        answer(applied(false));
        await done;
      });
      expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-b");
      expect(probe().editor.controller.toast).toBeNull();
    });
  });

  it("still shows the toast when the writer is back in the review it was sent from", async () => {
    const answer = heldCommand(mocks.applyDraftChanges);
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      await open(probe, draftA);
      await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
      let done!: Promise<unknown>;
      await act(async () => {
        done = probe().editor.controller.applyChanges(draftA, change("2"));
      });
      await act(async () => {
        answer(applied(false));
        await done;
      });
      expect(probe().editor.controller.toast?.code).toBe("applied");
    });
  });
});

describe("a batch whose caller changes Work", () => {
  it("sends the remaining drafts to the Work it began in", async () => {
    const answer = heldCommand(mocks.applyDraftChanges);
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      const viewA = await probe().mountDraftChanges(target(draftA));
      const viewB = await probe().mountDraftChanges(target(draftB));
      await vi.waitFor(() => expect(viewA().status).toBe("ready"));
      await vi.waitFor(() => expect(viewB().status).toBe("ready"));
      let batch!: Promise<unknown>;
      await act(async () => {
        batch = probe().chatRunner.applyBatch([
          { draft: draftA, selection: change("2") },
          { draft: draftB, selection: change("3") },
        ]);
      });
      expect(mocks.applyDraftChanges).toHaveBeenCalledTimes(1);

      // The writer opens a chat of another Work while the first request waits.
      await probe().moveChatToWork(workC);
      mocks.applyDraftChanges.mockResolvedValue(answeredFor(draftB, applied(false, "3")));
      await act(async () => {
        answer(applied(false));
        await batch;
      });

      const sent = mocks.applyDraftChanges.mock.calls.map((call) => [call[1], call[2]]);
      expect(sent).toEqual([
        ["work-a", "document-a"],
        ["work-a", "document-b"],
      ]);
    });
  });
});
