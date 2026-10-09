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

const MODES = ["apply", "discard"] as const;

/** A selection command of a mode, as the Editor's controller and the Chat's runner send it. */
function commandOf(mode: (typeof MODES)[number]) {
  const apply = mode === "apply";
  return {
    mock: apply ? mocks.applyDraftChanges : mocks.discardDraft,
    sendInEditor: (probe: ScopeProbe, id: string) =>
      apply
        ? probe.editor.controller.applyChanges(draftA, change(id))
        : probe.editor.controller.discardChanges(draftA, change(id)),
    sendInChat: (probe: ScopeProbe, id: string) =>
      apply
        ? probe.chatRunner.applyChanges(draftA, change(id))
        : probe.chatRunner.discardChanges(draftA, change(id)),
    answer: (closes: boolean) => (apply ? applied(closes) : discarded(closes)),
    toast: apply ? "applied" : "discarded",
  };
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

describe("two last commands for one open draft in the same turn", () => {
  it.each(MODES)("%s: keeps the first command's hold when the second is refused", async (mode) => {
    const { mock, sendInChat, answer: answered } = commandOf(mode);
    mocks.getDraftPreview.mockResolvedValue(previewOf("2"));
    const answer = heldCommand(mock);
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      await open(probe, draftA);
      await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
      let first!: Promise<unknown>;
      let second: unknown;
      await act(async () => {
        first = sendInChat(probe(), "2");
        second = await sendInChat(probe(), "2");
      });
      expect(second).toEqual({ kind: "blocked" });
      expect(probe().editor.controller.isDisposing).toBe(true);
      expect(probe().editor.controller.inlineReview?.completion).toMatchObject({
        phase: "pending",
        mode,
      });

      await act(async () => {
        answer(answered(false));
        await first;
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
    });
  });
});

describe("an answer that arrives after the writer moved to another review", () => {
  it.each(MODES)("%s: shows no toast in the review they are in", async (mode) => {
    const { mock, sendInEditor, answer: answered } = commandOf(mode);
    const answer = heldCommand(mock);
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      await open(probe, draftA);
      await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
      let done!: Promise<unknown>;
      await act(async () => {
        done = sendInEditor(probe(), "2");
      });
      await open(probe, draftB);
      await act(async () => {
        answer(answered(false));
        await done;
      });
      expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-b");
      expect(probe().editor.controller.toast).toBeNull();
    });
  });

  it.each(
    MODES,
  )("%s: still shows the toast when the writer is back in the review it was sent from", async (mode) => {
    const { mock, sendInEditor, answer: answered, toast } = commandOf(mode);
    const answer = heldCommand(mock);
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      await open(probe, draftA);
      await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
      let done!: Promise<unknown>;
      await act(async () => {
        done = sendInEditor(probe(), "2");
      });
      await act(async () => {
        answer(answered(false));
        await done;
      });
      expect(probe().editor.controller.toast?.code).toBe(toast);
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

describe("a batch whose caller changes Work while Editor owns its first draft", () => {
  /** A is open in the Editor, so the batch's first item runs there and its second in the Chat's session. */
  async function editorFirstBatch(
    probe: () => ScopeProbe,
    mock: typeof mocks.discardDraft,
    run: () => Promise<unknown>,
    secondAnswer: object,
    firstAnswer: () => void,
  ) {
    await groupsListed(probe);
    await open(probe, draftA);
    const viewA = await probe().mountDraftChanges(target(draftA));
    const viewB = await probe().mountDraftChanges(target(draftB));
    await vi.waitFor(() => expect(viewA().status).toBe("ready"));
    await vi.waitFor(() => expect(viewB().status).toBe("ready"));
    let batch!: Promise<unknown>;
    await act(async () => {
      batch = run();
    });
    expect(mock).toHaveBeenCalledTimes(1);

    // The writer opens a chat of another Work while the first request waits.
    await probe().moveChatToWork(workC);
    mock.mockResolvedValue(answeredFor(draftB, secondAnswer));
    await act(async () => {
      firstAnswer();
      await batch;
    });
    return mock.mock.calls.map((call) => [call[1], call[2]]);
  }

  it("sends an Apply batch's second draft to the Work it began in", async () => {
    const answer = heldCommand(mocks.applyDraftChanges);
    await renderReviewScopes(async (probe) => {
      const sent = await editorFirstBatch(
        probe,
        mocks.applyDraftChanges,
        () =>
          probe().chatRunner.applyBatch([
            { draft: draftA, selection: change("2") },
            { draft: draftB, selection: change("3") },
          ]),
        applied(false, "3"),
        () => answer(applied(false)),
      );
      expect(sent).toEqual([
        ["work-a", "document-a"],
        ["work-a", "document-b"],
      ]);
    });
  });

  it("sends a Discard batch's second draft to the Work it began in", async () => {
    const answer = heldCommand(mocks.discardDraft);
    await renderReviewScopes(async (probe) => {
      const sent = await editorFirstBatch(
        probe,
        mocks.discardDraft,
        () =>
          probe().chatRunner.discardBatch([
            { draft: draftA, selection: change("2") },
            { draft: draftB, selection: change("3") },
          ]),
        discarded(false),
        () => answer(discarded(false)),
      );
      expect(sent).toEqual([
        ["work-a", "document-a"],
        ["work-a", "document-b"],
      ]);
    });
  });
});
