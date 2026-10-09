// @vitest-environment jsdom
/**
 * An open review follows its draft's generation. The server closes a draft by
 * resetting its branch one generation up and reuses the id (and the reset's
 * room) for the next proposal, so every ordering of a closing command's answer,
 * the reads that follow it and the next proposal must end in the same place:
 * a completion belongs to the generation its command acted on, and a review
 * shows the newest proposal of its draft. Real provider, controllers, mutations
 * and query cache; the network is the only fake, and it follows the server: the
 * reset and the next proposal share generation G+1 and its room.
 *
 * Every case runs for a last Apply and a last Discard unless it is about neither.
 */

import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { currentChangeCommandRecords } from "@/client/query/change-command-record";
import {
  currentDraftCommandRecords,
  pendingChangeCommand,
  readDraftsAfterCommands,
  resetDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { draftPreviewQueryOptions } from "@/client/query/useDraftPreview";
import {
  applied,
  change,
  discarded,
  draftA,
  listed,
  previewOf,
  renderReviewScopes,
  type ScopeProbe,
  work,
} from "@/test-support/draft-review-scope";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  applyDraftChanges: vi.fn(),
  applyDraft: vi.fn(),
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

const roomOf = (generation: number) => `review-room-a-g${generation}`;

/** The draft at generation G holding these changes, as the server's preview returns it. */
const proposal = (generation: number, ...ids: string[]) => ({
  ...previewOf(...ids),
  draftGeneration: generation,
  reviewRoomName: roomOf(generation),
  draftRevisionToken: `draft-g${generation}-${ids.join("+")}`,
});

/** The branch after a close: the same id, generation G, nothing to review. The next proposal shares it. */
const reset = (generation: number) => proposal(generation);

const listedAt = (generation: number, updatedAt = "2026-10-09T05:00:00.000Z") => ({
  drafts: [{ ...listed, draftGeneration: generation, updatedAt }],
});

const classIds = (probe: ScopeProbe) => probe.header.view.items.map((item) => item.change.classId);
const previewKey = projectQueryKeys.workDraftPreview(
  "project-a",
  "work-a",
  "document-a",
  "draft-a",
);
const draftsKey = projectQueryKeys.workDrafts("project-a", "work-a");

const MODES = ["apply", "discard"] as const;
type Mode = (typeof MODES)[number];

/** The selection command of a mode on a draft, and the answer that closes (or does not close) it. */
function commandOf(mode: Mode) {
  return {
    mock: mode === "apply" ? mocks.applyDraftChanges : mocks.discardDraft,
    send: (runner: ScopeProbe["chatRunner"], draft: typeof draftA, id: string) =>
      mode === "apply"
        ? runner.applyChanges(draft, change(id))
        : runner.discardChanges(draft, change(id)),
    sendInEditor: (probe: ScopeProbe, id: string) =>
      mode === "apply"
        ? probe.editor.controller.applyChanges(draftA, change(id))
        : probe.editor.controller.discardChanges(draftA, change(id)),
    answer: (closes: boolean, id: string) =>
      mode === "apply" ? applied(closes, id) : discarded(closes),
  };
}

/** A command whose answer the test releases. */
function heldCommand(mock: typeof mocks.discardDraft) {
  let answer!: (response: unknown) => void;
  mock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  return (response: unknown) => answer(response);
}

/** A draft-list read of another Work that stays out until settled, holding the global read fence. */
function deferredRead(scope: { projectId: string; workId: string }) {
  let finish!: (rows: []) => void;
  const read = readDraftsAfterCommands(
    scope,
    () => new Promise<[]>((resolve) => (finish = resolve)),
  );
  return {
    settle: async () => {
      finish([]);
      await read;
    },
  };
}

const relist = (probe: () => ScopeProbe) =>
  act(async () => {
    await probe().queryClient.invalidateQueries({ queryKey: draftsKey });
  });
const reread = (probe: () => ScopeProbe) =>
  act(async () => {
    await probe().queryClient.invalidateQueries({ queryKey: previewKey });
  });

async function reviewOpened(probe: () => ScopeProbe) {
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
  await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
  await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
}

const open = (probe: () => ScopeProbe, draft: { documentId: string; draftId: string }) =>
  act(async () => probe().editor.controller.enterInlineReview(draft.documentId, draft.draftId));

/** The server's state after a last change closes A: nothing listed, the reset to read. */
function serverClosesA(generation: number) {
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
  mocks.getDraftPreview.mockResolvedValue(reset(generation));
}

/** A's only change is handled and the server closes the draft: the review holds on No changes left. */
async function reviewClosed(probe: () => ScopeProbe, mode: Mode = "apply") {
  const { mock, sendInEditor, answer } = commandOf(mode);
  await reviewOpened(probe);
  mock.mockImplementation(async () => {
    serverClosesA(2);
    return answer(true, "2");
  });
  await act(async () => {
    await sendInEditor(probe(), "2");
  });
  await vi.waitFor(() => expect(probe().header.finished).toBe(true));
  await vi.waitFor(() => expect(probe().editor.files).toEqual([]));
}

/** Draft A holds changes 1 and 2, draft B only change 3, both at generation 1. */
function twoDrafts() {
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed, listedB] });
  mocks.getDraftPreview.mockImplementation(async (_p, _w, _d, id: string) =>
    id === "draft-b" ? { ...proposal(1, "3"), draftId: "draft-b" } : proposal(1, "1", "2"),
  );
}

async function groupsListed(probe: () => ScopeProbe) {
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
  await vi.waitFor(() => expect(probe().editor.files).toHaveLength(2));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftCommandRecords();
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  mocks.getDraftPreview.mockResolvedValue(proposal(1, "2"));
});

describe("E, C1, C2: a review opened on a draft whose last change another scope has sent", () => {
  /** The Chat sends the last change of unopened B, then the writer opens B before the answer. */
  async function sentThenOpened(probe: () => ScopeProbe, mode: Mode) {
    const { send } = commandOf(mode);
    await groupsListed(probe);
    await open(probe, draftA);
    const view = await probe().mountDraftChanges(target(draftB));
    await vi.waitFor(() => expect(view().status).toBe("ready"));
    let done!: Promise<unknown>;
    await act(async () => {
      done = send(probe().chatRunner, draftB, "3");
    });
    expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-a");
    await open(probe, draftB);
    return { view, done };
  }

  it.each(
    MODES,
  )("%s: adopts the pending completion, then holds on No changes left when the draft closed", async (mode) => {
    const { mock, answer } = commandOf(mode);
    const release = heldCommand(mock);
    twoDrafts();
    await renderReviewScopes(async (probe) => {
      const { done } = await sentThenOpened(probe, mode);
      expect(probe().editor.controller.inlineReview?.completion).toEqual({
        phase: "pending",
        mode,
        documentName: "Chapter 13",
      });

      // The server closes the draft with the command: the list loses it before the answer lands.
      mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
      mocks.getDraftPreview.mockImplementation(async (_p, _w, _d, id: string) =>
        id === "draft-b" ? { status: "gone" } : proposal(1, "1", "2"),
      );
      await act(async () => {
        release(answeredFor(draftB, answer(true, "3")));
        await done;
      });
      await vi.waitFor(() => expect(probe().editor.files).toHaveLength(1));
      expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-b");
      expect(probe().editor.controller.inlineReview?.completion).toEqual({
        phase: "closed",
        documentName: "Chapter 13",
      });
    });
  });

  it.each(MODES)("%s: carries on when the answer did not close the draft", async (mode) => {
    const { mock, answer } = commandOf(mode);
    const release = heldCommand(mock);
    twoDrafts();
    await renderReviewScopes(async (probe) => {
      const { done } = await sentThenOpened(probe, mode);
      expect(probe().editor.controller.inlineReview?.completion).toMatchObject({
        phase: "pending",
        mode,
      });

      await act(async () => {
        release(answeredFor(draftB, answer(false, "3")));
        await done;
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-b");
    });
  });

  it.each(
    MODES,
  )("%s: brings the review and the change back when the server refuses", async (mode) => {
    const { mock } = commandOf(mode);
    const release = heldCommand(mock);
    twoDrafts();
    await renderReviewScopes(async (probe) => {
      const { view, done } = await sentThenOpened(probe, mode);
      expect(probe().editor.controller.inlineReview?.completion?.phase).toBe("pending");
      expect(view().items).toEqual([]);

      await act(async () => {
        release(answeredFor(draftB, { status: "stale" }));
        await done;
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(view().items.map((item) => item.change.classId)).toEqual(["class-3"]);
      expect(view().items[0]?.failure).toMatchObject({ code: "stale" });
    });
  });

  it.each(
    MODES,
  )("%s: holds the closing answer when the entry and the answer share a flush", async (mode) => {
    const { mock, send, answer } = commandOf(mode);
    const release = heldCommand(mock);
    twoDrafts();
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      await open(probe, draftA);
      const view = await probe().mountDraftChanges(target(draftB));
      await vi.waitFor(() => expect(view().status).toBe("ready"));
      let done!: Promise<unknown>;
      await act(async () => {
        done = send(probe().chatRunner, draftB, "3");
      });
      mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
      mocks.getDraftPreview.mockImplementation(async (_p, _w, _d, id: string) =>
        id === "draft-b" ? { status: "gone" } : proposal(1, "1", "2"),
      );
      await act(async () => {
        probe().editor.controller.enterInlineReview(draftB.documentId, draftB.draftId);
        release(answeredFor(draftB, answer(true, "3")));
        await done;
      });
      await vi.waitFor(() => expect(probe().editor.files).toHaveLength(1));
      expect(probe().editor.controller.inlineReview).toMatchObject({
        draftId: "draft-b",
        completion: { phase: "closed", documentName: "Chapter 13" },
      });
    });
  });
});

describe("E: the draft the server reuses for the next proposal", () => {
  /**
   * The Chat's last change on unopened B closes it while an unrelated list read
   * (another Work's) is still out; an agent then proposes anew on B's id at the
   * next generation, and the writer opens B. The closing answer belongs to the
   * generation it closed.
   */
  it.each(
    MODES,
  )("%s: opens on the new proposal, not on No changes left, before and after the old read settles", async (mode) => {
    const { mock, send, answer } = commandOf(mode);
    const release = heldCommand(mock);
    twoDrafts();
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      await open(probe, draftA);
      const view = await probe().mountDraftChanges(target(draftB));
      await vi.waitFor(() => expect(view().status).toBe("ready"));
      const otherWorkRead = deferredRead({ projectId: "project-a", workId: "work-unrelated" });
      try {
        let done!: Promise<unknown>;
        await act(async () => {
          done = send(probe().chatRunner, draftB, "3");
        });
        mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
        mocks.getDraftPreview.mockImplementation(async (_p, _w, _d, id: string) =>
          id === "draft-b" ? { status: "gone" } : proposal(1, "1", "2"),
        );
        await act(async () => {
          release(answeredFor(draftB, answer(true, "3")));
          await done;
        });

        // The agent proposes again on the same draft id, one generation up.
        mocks.listWorkDrafts.mockResolvedValue({
          drafts: [
            listed,
            { ...listedB, draftGeneration: 2, updatedAt: "2026-10-09T04:00:00.000Z" },
          ],
        });
        mocks.getDraftPreview.mockImplementation(async (_p, _w, _d, id: string) =>
          id === "draft-b" ? { ...proposal(2, "4"), draftId: "draft-b" } : proposal(1, "1", "2"),
        );
        await act(async () => {
          await probe().queryClient.invalidateQueries();
        });
        await vi.waitFor(() =>
          expect(view().items.map((item) => item.change.classId)).toEqual(["class-4"]),
        );

        await probe().openDraft(draftB);
        await open(probe, draftB);
        expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
        expect(probe().editor.controller.inlineReview?.draftGeneration).toBe(2);
        expect(probe().header.view.finished).toBe(false);
        expect(classIds(probe())).toEqual(["class-4"]);

        await act(async () => otherWorkRead.settle());
        expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
        expect(classIds(probe())).toEqual(["class-4"]);
      } finally {
        await act(async () => otherWorkRead.settle());
      }
    });
  });

  /**
   * The closing command still awaits a slow Work-list read when the agent
   * proposes again and the preview read returns it. The claim's completion
   * belongs to the generation the command was sent against.
   */
  it.each(MODES)("%s: opens on the new proposal, before and after the claim ends", async (mode) => {
    const { mock, send, answer } = commandOf(mode);
    const release = heldCommand(mock);
    twoDrafts();
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      await open(probe, draftA);
      const view = await probe().mountDraftChanges(target(draftB));
      await vi.waitFor(() => expect(view().status).toBe("ready"));
      const reusedRows = {
        drafts: [listed, { ...listedB, draftGeneration: 2, updatedAt: "2026-10-09T04:00:00.000Z" }],
      };
      let finishList!: (response: unknown) => void;
      let done!: Promise<unknown>;
      try {
        await act(async () => {
          done = send(probe().chatRunner, draftB, "3");
        });
        mocks.listWorkDrafts.mockReturnValue(new Promise((resolve) => (finishList = resolve)));
        mocks.getDraftPreview.mockImplementation(async (_p, _w, _d, id: string) =>
          id === "draft-b" ? { ...proposal(2, "4"), draftId: "draft-b" } : proposal(1, "1", "2"),
        );
        await act(async () => {
          release(answeredFor(draftB, answer(true, "3")));
        });
        await vi.waitFor(() =>
          expect(view().items.map((item) => item.change.classId)).toEqual(["class-4"]),
        );
        expect(
          pendingChangeCommand(currentDraftCommandRecords(), target(draftB))?.draftClosed,
        ).toBeDefined();

        await probe().openDraft(draftB);
        await open(probe, draftB);
        expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
        expect(probe().header.view.finished).toBe(false);
        expect(classIds(probe())).toEqual(["class-4"]);

        mocks.listWorkDrafts.mockResolvedValue(reusedRows);
        await act(async () => {
          finishList(reusedRows);
          await done;
        });
        expect(
          pendingChangeCommand(currentDraftCommandRecords(), target(draftB))?.draftClosed,
        ).toBeUndefined();
        expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
        expect(classIds(probe())).toEqual(["class-4"]);
      } finally {
        mocks.listWorkDrafts.mockResolvedValue(reusedRows);
        await act(async () => {
          finishList?.(reusedRows);
          await done;
        });
      }
    });
  });
});

describe("E (unresolved), P, O4: a draft the server no longer has", () => {
  it.each(
    MODES,
  )("%s: entering an absent B after its claim was released exits through the list", async (mode) => {
    const { mock, send, answer } = commandOf(mode);
    const release = heldCommand(mock);
    twoDrafts();
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      await open(probe, draftA);
      const view = await probe().mountDraftChanges(target(draftB));
      await vi.waitFor(() => expect(view().status).toBe("ready"));
      let done!: Promise<unknown>;
      await act(async () => {
        done = send(probe().chatRunner, draftB, "3");
      });
      mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
      mocks.getDraftPreview.mockImplementation(async (_p, _w, _d, id: string) =>
        id === "draft-b" ? { status: "gone" } : proposal(1, "1", "2"),
      );
      await act(async () => {
        release(answeredFor(draftB, answer(true, "3")));
        await done;
      });
      expect(
        pendingChangeCommand(currentDraftCommandRecords(), target(draftB))?.draftClosed,
      ).toBeUndefined();
      await vi.waitFor(() => expect(probe().editor.files).toHaveLength(1));
      await probe().openDraft(draftB);
      await open(probe, draftB);
      await vi.waitFor(() => expect(probe().editor.controller.inlineReview).toBeNull());
      expect(probe().header.view.finished).toBe(false);
    });
  });

  it("opening an unlisted draft directly ends the same way", async () => {
    mocks.getDraftPreview.mockImplementation(async (_p, _w, _d, id: string) =>
      id === "draft-b" ? { status: "gone" } : proposal(1, "2"),
    );
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await probe().openDraft(draftB);
      await open(probe, draftB);
      await vi.waitFor(() => expect(probe().editor.controller.inlineReview).toBeNull());
      expect(probe().header.view.finished).toBe(false);
    });
  });
});

describe("O4, C2: the close's reset beats the answer (R1)", () => {
  it.each(
    MODES,
  )("%s: a reset preview read before the answer still ends on No changes left", async (mode) => {
    const { mock, sendInEditor, answer } = commandOf(mode);
    const release = heldCommand(mock);
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let done!: Promise<unknown>;
      await act(async () => {
        done = sendInEditor(probe(), "2");
      });
      expect(probe().editor.controller.inlineReview?.completion?.phase).toBe("pending");

      // The server committed and reset the branch; an independent read beats the HTTP answer.
      mocks.getDraftPreview.mockResolvedValue(reset(2));
      await reread(probe);
      expect(probe().editor.controller.inlineReview).toMatchObject({
        draftGeneration: 1,
        completion: { phase: "pending", mode },
      });
      mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
      await act(async () => {
        release(answer(true, "2"));
        await done;
      });
      expect(probe().editor.controller.inlineReview?.completion?.phase).toBe("closed");
      expect(probe().header.finished).toBe(true);
    });
  });
});

describe("C2, O3: the next proposal arrives with the closing command's own reads", () => {
  it.each(MODES)("%s: re-enters the next proposal with its room", async (mode) => {
    const { mock, sendInEditor, answer } = commandOf(mode);
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      mock.mockImplementation(async () => {
        mocks.listWorkDrafts.mockResolvedValue(listedAt(2));
        mocks.getDraftPreview.mockResolvedValue(proposal(2, "5"));
        return answer(true, "2");
      });
      await act(async () => {
        await sendInEditor(probe(), "2");
      });
      await vi.waitFor(() => expect(probe().header.finished).toBe(false));
      expect(classIds(probe())).toEqual(["class-5"]);
      expect(probe().editor.controller.inlineReview).toMatchObject({ draftGeneration: 2 });
      await vi.waitFor(() => expect(probe().editor.controller.reviewRoomName).toBe(roomOf(2)));
    });
  });
});

describe("O3, C4: a new proposal is cached before the old answer (R2)", () => {
  it.each(
    MODES,
  )("%s: moves the open review to the new generation's room and ignores the old answer", async (mode) => {
    const { mock, sendInEditor, answer } = commandOf(mode);
    const release = heldCommand(mock);
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let done!: Promise<unknown>;
      await act(async () => {
        done = sendInEditor(probe(), "2");
      });
      mocks.getDraftPreview.mockResolvedValue(proposal(2, "5"));
      mocks.listWorkDrafts.mockResolvedValue(listedAt(2));
      await act(async () => {
        await probe().queryClient.invalidateQueries();
      });
      // At once, under "Applying": the finished state would already be false.
      await vi.waitFor(() => expect(classIds(probe())).toEqual(["class-5"]));
      expect(probe().header.finished).toBe(false);
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();

      await act(async () => {
        release(answer(true, "2"));
        await done;
      });
      expect(probe().header.finished).toBe(false);
      expect(classIds(probe())).toEqual(["class-5"]);
      expect(probe().editor.controller.inlineReview).toMatchObject({ draftGeneration: 2 });
      await vi.waitFor(() => expect(probe().editor.controller.reviewRoomName).toBe(roomOf(2)));
    });
  });
});

describe("O3: a finished review takes up its draft's next proposal", () => {
  it.each(
    MODES,
  )("%s: re-enters in place, completion cleared, the new room and changes shown", async (mode) => {
    await renderReviewScopes(async (probe) => {
      await reviewClosed(probe, mode);

      // The chat writes the document again: the list row (the catalog wake) arrives first.
      mocks.listWorkDrafts.mockResolvedValue(listedAt(2));
      mocks.getDraftPreview.mockResolvedValue(proposal(2, "5"));
      await relist(probe);

      await vi.waitFor(() => expect(probe().header.finished).toBe(false));
      await vi.waitFor(() => expect(classIds(probe())).toEqual(["class-5"]));
      expect(probe().editor.controller.inlineReview).toMatchObject({
        documentId: "document-a",
        draftId: "draft-a",
        draftGeneration: 2,
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      await vi.waitFor(() => expect(probe().editor.controller.reviewRoomName).toBe(roomOf(2)));
      expect(probe().editor.controller.marksVisible).toBe(true);
    });
  });

  it.each(MODES)("%s: re-enters from a cached preview alone, before any list row", async (mode) => {
    await renderReviewScopes(async (probe) => {
      await reviewClosed(probe, mode);
      mocks.getDraftPreview.mockResolvedValue(proposal(2, "5"));
      await reread(probe);
      await vi.waitFor(() => expect(probe().header.finished).toBe(false));
      await vi.waitFor(() => expect(classIds(probe())).toEqual(["class-5"]));
    });
  });
});

describe("O2: nothing to take up", () => {
  it.each(
    MODES,
  )("%s: a list read of the closed generation after the close lists no change and reopens nothing", async (mode) => {
    await renderReviewScopes(async (probe) => {
      await reviewClosed(probe, mode);
      // A list read that began before the close still lists the draft, at the generation it closed.
      mocks.listWorkDrafts.mockResolvedValue(listedAt(1, "2026-10-06T23:00:00.000Z"));
      await relist(probe);
      await act(async () => undefined);

      expect(probe().header.finished).toBe(true);
      expect(classIds(probe())).toEqual([]);
      expect(probe().editor.controller.reviewRoomName).toBe(roomOf(1));
      expect(probe().editor.controller.inlineReview?.completion).toMatchObject({ phase: "closed" });
    });
  });

  it.each(
    MODES,
  )("%s: stays finished while the draft stays out of the list, and reads nothing", async (mode) => {
    await renderReviewScopes(async (probe) => {
      await reviewClosed(probe, mode);
      const reads = mocks.getDraftPreview.mock.calls.length;
      await relist(probe);
      await act(async () => undefined);
      expect(mocks.getDraftPreview.mock.calls.length).toBe(reads);
      expect(probe().header.finished).toBe(true);
      expect(probe().editor.controller.inlineReview?.completion).toMatchObject({ phase: "closed" });
    });
  });
});

describe("invariant 4: a list without the draft, a preview with its next proposal", () => {
  // A remote close and next write happened; the list was read between them (no row) and the
  // preview after them (G+1 with changes). Whichever lands first, the review ends on G+1.
  it.each([
    "list-first",
    "preview-first",
  ] as const)("%s: a review with no completion follows the proposal, not the empty list", async (order) => {
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await vi.waitFor(() => expect(probe().editor.controller.reviewRoomName).toBe(roomOf(1)));
      mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
      if (order === "preview-first") {
        mocks.getDraftPreview.mockResolvedValue(proposal(2, "5"));
        await reread(probe);
        await vi.waitFor(() =>
          expect(probe().editor.controller.inlineReview?.draftGeneration).toBe(2),
        );
        await relist(probe);
      } else {
        // The list lands while the preview is still the review's own generation; the preview read
        // it triggers (or one already in flight) lands after.
        let landed!: (preview: unknown) => void;
        mocks.getDraftPreview.mockReturnValueOnce(new Promise((resolve) => (landed = resolve)));
        await relist(probe);
        mocks.getDraftPreview.mockResolvedValue(proposal(2, "5"));
        await act(async () => landed(proposal(2, "5")));
      }
      await vi.waitFor(() =>
        expect(probe().editor.controller.inlineReview?.draftGeneration).toBe(2),
      );
      await vi.waitFor(() => expect(probe().editor.controller.reviewRoomName).toBe(roomOf(2)));
      expect(probe().editor.controller.inlineReview).toMatchObject({ draftId: "draft-a" });
      expect(classIds(probe())).toEqual(["class-5"]);
    });
  });

  it("a genuine external close still ends the review", async () => {
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await vi.waitFor(() => expect(probe().editor.controller.reviewRoomName).toBe(roomOf(1)));
      mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
      mocks.getDraftPreview.mockResolvedValue(reset(2));
      await relist(probe);
      await reread(probe);
      await vi.waitFor(() => expect(probe().editor.controller.inlineReview).toBeNull());
    });
  });
});

describe("O1, invariant 1: a read of an earlier generation never goes back", () => {
  it.each(
    MODES,
  )("%s: a preview read begun before the closing answer cannot reopen the review or replace the cache", async (mode) => {
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let staleRead!: (preview: unknown) => void;
      mocks.getDraftPreview.mockReturnValueOnce(
        new Promise((resolve) => {
          staleRead = resolve;
        }),
      );
      await act(async () => {
        void probe().queryClient.invalidateQueries({ queryKey: previewKey });
      });
      commandOf(mode).mock.mockImplementation(async () => {
        serverClosesA(2);
        return commandOf(mode).answer(true, "2");
      });
      await act(async () => {
        await commandOf(mode).sendInEditor(probe(), "2");
      });
      expect(probe().header.finished).toBe(true);
      mocks.listWorkDrafts.mockResolvedValue(listedAt(1, "2026-10-06T23:00:00.000Z"));
      await relist(probe);
      await act(async () => staleRead(proposal(1, "2")));

      expect(probe().header.finished).toBe(true);
      expect(classIds(probe())).toEqual([]);
      expect(probe().queryClient.getQueryData(previewKey)).toMatchObject({
        draftGeneration: 2,
        operations: [],
      });
    });
  });

  it.each(
    MODES,
  )("%s: a stale read of G after re-entering G+1 leaves the cache and the review on G+1", async (mode) => {
    await renderReviewScopes(async (probe) => {
      await reviewClosed(probe, mode);
      mocks.getDraftPreview.mockResolvedValue(proposal(2, "5"));
      mocks.listWorkDrafts.mockResolvedValue(listedAt(2));
      await relist(probe);
      await reread(probe);
      await vi.waitFor(() => expect(classIds(probe())).toEqual(["class-5"]));

      // A read answered from before the close lands after the next proposal's.
      mocks.getDraftPreview.mockResolvedValue(proposal(1, "1", "2"));
      await act(async () => {
        const read = await probe().queryClient.fetchQuery({
          ...draftPreviewQueryOptions({ projectId: "project-a", workId: "work-a", ...draftA }),
          staleTime: 0,
        });
        expect(read).toMatchObject({ draftGeneration: 1 });
      });
      expect(probe().queryClient.getQueryData(previewKey)).toMatchObject({ draftGeneration: 2 });
      expect(classIds(probe())).toEqual(["class-5"]);
      expect(probe().editor.controller.inlineReview).toMatchObject({ draftGeneration: 2 });
    });
  });
});

describe("O3, C1: a command already running on the new proposal", () => {
  it.each(
    MODES,
  )("%s: the re-entry adopts its pending completion, and its answer closes it", async (mode) => {
    const { mock, sendInEditor, answer } = commandOf(mode);
    await renderReviewScopes(async (probe) => {
      await reviewClosed(probe, mode);
      mocks.getDraftPreview.mockResolvedValue(proposal(2, "5"));
      await reread(probe);
      const release = heldCommand(mock);
      let done!: Promise<unknown>;
      await act(async () => {
        done = sendInEditor(probe(), "5");
      });
      mocks.listWorkDrafts.mockResolvedValue(listedAt(2));
      await relist(probe);
      await vi.waitFor(() =>
        expect(probe().editor.controller.inlineReview?.completion).toMatchObject({
          phase: "pending",
          mode,
        }),
      );
      await vi.waitFor(() => expect(probe().editor.controller.reviewRoomName).toBe(roomOf(2)));

      mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
      mocks.getDraftPreview.mockResolvedValue(reset(3));
      await act(async () => {
        release(answer(true, "5"));
        await done;
      });
      expect(probe().header.finished).toBe(true);
    });
  });
});

describe("L: a late re-entry read after the writer left", () => {
  it.each(
    MODES.flatMap((mode) => (["leave", "next"] as const).map((action) => [mode, action] as const)),
  )("%s: cannot undo %s", async (mode, action) => {
    await renderReviewScopes(async (probe) => {
      await reviewClosed(probe, mode);
      let finish!: (preview: unknown) => void;
      mocks.getDraftPreview.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      mocks.getDraftPreview.mockResolvedValue(proposal(2, "5"));
      mocks.listWorkDrafts.mockResolvedValue({
        drafts: [
          ...listedAt(2).drafts,
          { ...listed, documentId: "document-b", draftId: "draft-b", documentName: "Z" },
        ],
      });
      const reads = mocks.getDraftPreview.mock.calls.length;
      await relist(probe);
      // The list row re-entered the review; its room read is the one held.
      await vi.waitFor(() =>
        expect(mocks.getDraftPreview.mock.calls.length).toBeGreaterThan(reads),
      );
      if (action === "leave") {
        await act(async () => probe().editor.controller.exitReview());
      } else {
        expect(probe().header.next?.draft.draftId).toBe("draft-b");
        await probe().openDraft({ documentId: "document-b", draftId: "draft-b" });
        await open(probe, { documentId: "document-b", draftId: "draft-b" });
      }
      await act(async () => finish(proposal(2, "5")));
      if (action === "leave") expect(probe().editor.controller.inlineReview).toBeNull();
      else expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-b");
    });
  });
});

describe("C4, C5: a claim whose generation is not the shown one", () => {
  it.each(MODES)("%s: the old closing claim cannot be adopted again on re-entry", async (mode) => {
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let listDone!: (rows: unknown) => void;
      const { mock, sendInEditor, answer } = commandOf(mode);
      const release = heldCommand(mock);
      let done!: Promise<unknown>;
      await act(async () => {
        done = sendInEditor(probe(), "2");
      });
      mocks.listWorkDrafts.mockReturnValue(new Promise((resolve) => (listDone = resolve)));
      mocks.getDraftPreview.mockResolvedValue(reset(2));
      await act(async () => release(answer(true, "2")));
      await vi.waitFor(() => expect(probe().header.finished).toBe(true));

      mocks.getDraftPreview.mockResolvedValue(proposal(2, "5"));
      mocks.listWorkDrafts.mockResolvedValue(listedAt(2));
      await relist(probe);
      await vi.waitFor(() => expect(probe().header.finished).toBe(false));
      expect(classIds(probe())).toEqual(["class-5"]);
      await act(async () => {
        listDone(listedAt(2));
        await done;
      });
      expect(probe().header.finished).toBe(false);
      expect(classIds(probe())).toEqual(["class-5"]);
    });
  });

  it.each(
    MODES,
  )("%s: a refusal after the cached token changed withdraws the prediction", async (mode) => {
    const { mock, sendInEditor } = commandOf(mode);
    const release = heldCommand(mock);
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let done!: Promise<unknown>;
      await act(async () => {
        done = sendInEditor(probe(), "2");
      });
      // The writer edits the draft meanwhile: another token, the same generation.
      mocks.getDraftPreview.mockResolvedValue({
        ...proposal(1, "2"),
        draftRevisionToken: "same-generation-writer-edit",
      });
      await reread(probe);
      await act(async () => {
        release({ status: "stale", draftId: "draft-a" });
        await done;
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(classIds(probe())).toEqual(["class-2"]);
      expect(probe().header.view.items[0]?.failure).toBeDefined();
    });
  });
});

describe("S: the review's room goes stale while Applying", () => {
  it.each(
    MODES,
  )("%s: stays on the completion, reads the current room, and closes on the answer", async (mode) => {
    const { mock, sendInEditor, answer } = commandOf(mode);
    const release = heldCommand(mock);
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await vi.waitFor(() => expect(probe().editor.controller.reviewRoomName).toBe(roomOf(1)));
      let done!: Promise<unknown>;
      await act(async () => {
        done = sendInEditor(probe(), "2");
      });
      expect(probe().editor.controller.inlineReview?.completion?.phase).toBe("pending");

      // The server committed and reset: the review room of generation 1 is refused on reconnect.
      mocks.getDraftPreview.mockResolvedValue(reset(2));
      await act(async () =>
        probe().editor.controller.reviewRoomStale("document-a", "draft-a", roomOf(1)),
      );
      await vi.waitFor(() => expect(probe().editor.controller.reviewRoomName).toBe(roomOf(2)));
      expect(probe().editor.controller.inlineReview).toMatchObject({
        draftGeneration: 1,
        completion: { phase: "pending", mode },
      });

      mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
      await act(async () => {
        release(answer(true, "2"));
        await done;
      });
      expect(probe().editor.controller.inlineReview?.completion?.phase).toBe("closed");
      expect(probe().header.finished).toBe(true);
    });
  });

  it("a signal from a room the review has left is ignored", async () => {
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await vi.waitFor(() => expect(probe().editor.controller.reviewRoomName).toBe(roomOf(1)));
      const reads = mocks.getDraftPreview.mock.calls.length;
      await act(async () =>
        probe().editor.controller.reviewRoomStale("document-a", "draft-a", roomOf(0)),
      );
      expect(probe().editor.controller.reviewRoomName).toBe(roomOf(1));
      expect(mocks.getDraftPreview.mock.calls.length).toBe(reads);
    });
  });
});

describe("B: a whole-draft batch holds the open review", () => {
  it.each(
    MODES.flatMap((mode) => [1, 2].map((count) => [mode, count] as const)),
  )("%s batch of %s keeps the pending and closed review", async (mode, count) => {
    twoDrafts();
    const mock = mode === "apply" ? mocks.applyDraft : mocks.discardDraft;
    const release = heldCommand(mock);
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      await open(probe, draftA);
      await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
      let done!: Promise<unknown>;
      await act(async () => {
        done = probe().editor.controller.disposeDrafts(
          mode,
          count === 1 ? [draftA] : [draftA, draftB],
        );
      });
      expect(probe().header.completing).toBe(mode);
      expect(probe().header.finished).toBe(false);
      mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
      mock.mockResolvedValue(mode === "apply" ? { status: "applied" } : discarded(true));
      await act(async () => {
        release(mode === "apply" ? { status: "applied" } : discarded(true));
        await done;
      });
      expect(probe().header.completing).toBeNull();
      expect(probe().header.finished).toBe(true);
      expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-a");
    });
  });

  it.each(MODES)("%s refusal reopens the review", async (mode) => {
    twoDrafts();
    const mock = mode === "apply" ? mocks.applyDraft : mocks.discardDraft;
    let reject!: (error: unknown) => void;
    mock.mockImplementation(
      () =>
        new Promise((_, rejectRequest) => {
          reject = rejectRequest;
        }),
    );
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      await open(probe, draftA);
      await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
      let done!: Promise<unknown>;
      await act(async () => {
        done = probe().editor.controller.disposeDrafts(mode, [draftA]);
      });
      expect(probe().header.completing).toBe(mode);
      await act(async () => {
        reject(new HttpResponseError("injected", 500, null));
        await done;
      });
      expect(probe().header.completing).toBeNull();
      expect(probe().header.finished).toBe(false);
      expect(probe().header.commandError?.code).toBe(`${mode}-server-error`);
    });
  });
});

describe("claims and batches", () => {
  it.each(
    MODES,
  )("a selection %s claims the draft synchronously, with the generation it saw", async (mode) => {
    twoDrafts();
    const { mock, answer } = commandOf(mode);
    const release = heldCommand(mock);
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      await open(probe, draftA);
      await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
      let done!: Promise<unknown>;
      await act(async () => {
        const items = [{ draft: draftA, selection: change("1", "2") }];
        done =
          mode === "apply"
            ? probe().chatRunner.applyBatch(items)
            : probe().chatRunner.discardBatch(items);
        expect(pendingChangeCommand(currentDraftCommandRecords(), target(draftA))).toMatchObject({
          mode,
          completesDraft: true,
          draftGeneration: 1,
        });
        expect(currentChangeCommandRecords().queued).toEqual({});
      });
      await act(async () => {
        release(answer(false, "2"));
        await done;
      });
    });
  });

  it.each(
    MODES,
  )("a selection %s batch finishes when its Work is archived while the first request waits", async (mode) => {
    twoDrafts();
    const { mock, answer } = commandOf(mode);
    const release = heldCommand(mock);
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      const a = await probe().mountDraftChanges(target(draftA));
      const b = await probe().mountDraftChanges(target(draftB));
      await vi.waitFor(() => expect(a().status).toBe("ready"));
      await vi.waitFor(() => expect(b().status).toBe("ready"));
      let done!: Promise<unknown>;
      await act(async () => {
        const items = [
          { draft: draftA, selection: change("1", "2") },
          { draft: draftB, selection: change("3") },
        ];
        done =
          mode === "apply"
            ? probe().chatRunner.applyBatch(items)
            : probe().chatRunner.discardBatch(items);
      });
      await probe().moveChatToWork({ ...work, archivedAt: "2026-10-08T00:00:00.000Z" });
      expect(probe().chat.controller.dispositionLocked).toBe(true);
      mock.mockResolvedValue(answeredFor(draftB, answer(false, "3")));
      await act(async () => {
        release(answer(false, "2"));
        await done;
      });
      expect(mock).toHaveBeenCalledTimes(2);
      expect(probe().chat.controller.dispositionLocked).toBe(true);
      expect(probe().chat.controller.isDisposing).toBe(false);
      expect(probe().editor.controller.inlineReview).toBeNull();
    });
  });

  it.each(
    MODES,
  )("a whole-draft %s batch finishes when its Work is archived while the first request waits", async (mode) => {
    twoDrafts();
    const mock = mode === "apply" ? mocks.applyDraft : mocks.discardDraft;
    const release = heldCommand(mock);
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      let done!: Promise<unknown>;
      await act(async () => {
        done = probe().chat.controller.disposeDrafts(mode, [draftA, draftB]);
      });
      await probe().moveChatToWork({ ...work, archivedAt: "2026-10-08T00:00:00.000Z" });
      expect(probe().chat.controller.dispositionLocked).toBe(true);
      mock.mockResolvedValue(
        mode === "apply" ? { status: "applied" } : answeredFor(draftB, discarded(false)),
      );
      await act(async () => {
        release(mode === "apply" ? { status: "applied" } : discarded(false));
        await done;
      });
      expect(mock).toHaveBeenCalledTimes(2);
      expect(probe().chat.controller.dispositionLocked).toBe(true);
      expect(probe().chat.controller.isDisposing).toBe(false);
      expect(probe().editor.controller.inlineReview).toBeNull();
    });
  });

  it.each(MODES)("a direct whole-draft %s leaves the review it was sent from", async (mode) => {
    twoDrafts();
    const mock = mode === "apply" ? mocks.applyDraft : mocks.discardDraft;
    const release = heldCommand(mock);
    await renderReviewScopes(async (probe) => {
      await groupsListed(probe);
      await open(probe, draftA);
      await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
      let done!: Promise<unknown>;
      await act(async () => {
        done = probe().editor.controller[mode](draftA.documentId, draftA.draftId);
      });
      expect(probe().editor.controller.isDisposing).toBe(true);
      expect(probe().header.completing).toBeNull();
      await act(async () => {
        release(mode === "apply" ? { status: "applied" } : discarded(true));
        await done;
      });
      expect(probe().editor.controller.inlineReview).toBeNull();
    });
  });
});
