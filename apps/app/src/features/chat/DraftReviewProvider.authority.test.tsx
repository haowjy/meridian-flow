// @vitest-environment jsdom
/**
 * Command authority and read ownership across the review's real surfaces: the
 * Editor's and the Chat's scopes over one Work, their controllers, mutations
 * and query cache. The network is the only fake.
 */

import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponseError, MeridianApiError } from "@/client/api/http-client";
import {
  currentDraftCommandRecords,
  draftCommandFailure,
  resetDraftCommandRecords,
} from "@/client/query/draft-command-record";
import {
  applied,
  change,
  listed,
  preview,
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

const listedB = {
  ...listed,
  draftId: "draft-b",
  documentId: "document-b",
  documentName: "Chapter 13",
};

const classIds = (probe: ScopeProbe) => probe.header.view.items.map((item) => item.change.classId);

async function reviewOpened(probe: () => ScopeProbe) {
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
  await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
  await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftCommandRecords();
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  mocks.getDraftPreview.mockResolvedValue(preview);
});

describe("one command authority per draft across the Editor and the Chat", () => {
  it("a per-change Apply in the Editor blocks the Chat's whole-draft Apply and Discard, and both surfaces read busy", async () => {
    let answer!: (response: unknown) => void;
    mocks.applyDraftChanges.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let done: Promise<unknown> | undefined;
      await act(async () => {
        done = probe().editor.controller.applyChange(change("2"));
      });

      expect(probe().chat.controller.isDisposing).toBe(true);
      expect(probe().chat.controller.dispositionLocked).toBe(true);
      expect(probe().editor.controller.isDisposing).toBe(true);
      let discard: unknown;
      let apply: unknown;
      await act(async () => {
        discard = await probe().chat.controller.discard("document-a", "draft-a");
        apply = await probe().chat.controller.apply("document-a", "draft-a");
      });
      expect(discard).toEqual({ kind: "blocked" });
      expect(apply).toEqual({ kind: "blocked" });
      expect(mocks.discardDraft).not.toHaveBeenCalled();
      expect(mocks.applyDraft).not.toHaveBeenCalled();

      await act(async () => {
        answer(applied(false));
        await done;
      });
      await vi.waitFor(() => expect(probe().chat.controller.isDisposing).toBe(false));
      expect(mocks.applyDraftChanges).toHaveBeenCalledTimes(1);
    });
  });

  it("a whole-draft Apply in the Chat blocks the Editor's per-change Apply, and both surfaces read busy", async () => {
    let confirm!: () => void;
    mocks.applyDraft.mockReturnValue(new Promise<void>((resolve) => (confirm = resolve)));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let done: Promise<unknown> | undefined;
      await act(async () => {
        done = probe().chat.controller.apply("document-a", "draft-a");
      });
      expect(probe().editor.controller.isDisposing).toBe(true);
      expect(probe().header.locked).toBe(true);

      let outcome: unknown;
      await act(async () => {
        outcome = await probe().editor.controller.applyChange(change("2"));
      });
      expect(outcome).toEqual({ kind: "blocked" });
      expect(mocks.applyDraftChanges).not.toHaveBeenCalled();
      // The blocked command left no trace on the change.
      expect(classIds(probe())).toEqual(["class-1", "class-2"]);

      await act(async () => {
        confirm();
        await done;
      });
    });
  });
});

describe("the room-opening read", () => {
  it("cannot bring back a change handled while it was in flight", async () => {
    mocks.applyDraftChanges.mockResolvedValue(applied(false));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => probe().editor.controller.exitInlineReview());

      let oldRead!: (response: unknown) => void;
      mocks.getDraftPreview.mockImplementationOnce(
        () => new Promise((resolve) => (oldRead = resolve)),
      );
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      expect(probe().editor.controller.reviewRoomName).toBeNull();
      // The list is already actionable from the cache.
      await vi.waitFor(() => expect(classIds(probe())).toEqual(["class-1", "class-2"]));

      mocks.getDraftPreview.mockResolvedValue(previewOf("1"));
      await act(async () => {
        await probe().editor.controller.applyChange(change("2"));
      });
      await vi.waitFor(() => expect(classIds(probe())).toEqual(["class-1"]));

      // The older read answers last, with the change still in it.
      await act(async () => oldRead(preview));
      await act(async () => undefined);
      expect(classIds(probe())).toEqual(["class-1"]);
      // The review still finds its room.
      await vi.waitFor(() =>
        expect(probe().editor.controller.reviewRoomName).toBe("review-room-a"),
      );
    });
  });

  it("commits no room to a review that has moved on", async () => {
    await renderReviewScopes(async (probe) => {
      await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
      let slow!: (response: unknown) => void;
      mocks.getDraftPreview.mockImplementationOnce(
        () => new Promise((resolve) => (slow = resolve)),
      );
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      await act(async () => probe().editor.controller.exitInlineReview());
      await act(async () => slow({ ...preview, reviewRoomName: "stale-room" }));
      expect(probe().editor.controller.reviewRoomName).toBeNull();
      expect(probe().editor.controller.inlineReview).toBeNull();
    });
  });
});

/** What the draft's own record holds, whichever draft the review is on. */
const failureOf = (_probe: ScopeProbe, documentId: string) =>
  draftCommandFailure(currentDraftCommandRecords(), {
    projectId: "project-a",
    workId: work.id,
    documentId,
    draftId: `draft-${documentId.slice(-1)}`,
  }) ?? undefined;

describe("a whole-draft Apply the server rejects after the review moved on", () => {
  it("keeps its failure on that draft's record and shows it where the draft is listed, without navigating back", async () => {
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed, listedB] });
    let reject!: (error: unknown) => void;
    mocks.applyDraft.mockReturnValue(
      new Promise((_resolve, rejectApply) => (reject = rejectApply)),
    );
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await vi.waitFor(() => expect(probe().editor.groups).toHaveLength(2));
      let done: Promise<unknown> | undefined;
      // Apply draft opens the next draft at once; the request is still in flight.
      await act(async () => {
        done = probe().editor.controller.apply("document-a", "draft-a");
        probe().editor.controller.enterInlineReview("document-b", "draft-b");
      });
      await act(async () => {
        reject(new HttpResponseError("refused", 409, {}));
        await done;
      });

      expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-b");
      expect(failureOf(probe(), "document-a")).toEqual({ code: "apply-server-error" });
      expect(failureOf(probe(), "document-b")).toBeUndefined();
    });
  });

  it("holds a lost answer on the draft the same way, as unknown", async () => {
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed, listedB] });
    mocks.applyDraft.mockRejectedValue(new TypeError("Failed to fetch"));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await vi.waitFor(() => expect(probe().editor.groups).toHaveLength(2));
      await act(async () => {
        await probe().editor.controller.apply("document-a", "draft-a");
        probe().editor.controller.enterInlineReview("document-b", "draft-b");
      });
      expect(failureOf(probe(), "document-a")).toEqual({ code: "apply-unknown" });
    });
  });
});

describe("a per-change Apply that got no answer", () => {
  it("stays unknown on its change: never a refusal, and not inferred from the list", async () => {
    mocks.applyDraftChanges.mockRejectedValue(new TypeError("Failed to fetch"));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        await probe().editor.controller.applyChange(change("2"));
      });
      await act(async () => undefined);
      // The refetch still lists the change: that is not proof the Apply failed.
      expect(classIds(probe())).toEqual(["class-1", "class-2"]);
      const item = probe().header.view.items.find((entry) => entry.change.classId === "class-2");
      expect(item?.failure).toMatchObject({ phase: "failed", mode: "apply", code: "unknown" });
    });
  });

  it("a refused request is a confirmed failure, apart from the unknown one", async () => {
    mocks.applyDraftChanges.mockRejectedValue(new HttpResponseError("server error", 500, {}));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        await probe().editor.controller.applyChange(change("2"));
      });
      const item = probe().header.view.items.find((entry) => entry.change.classId === "class-2");
      expect(item?.failure).toMatchObject({ code: "server-error" });
    });
  });

  it("holds a typed server refusal with its reason, not as a connection failure", async () => {
    mocks.applyDraftChanges.mockRejectedValue(
      new MeridianApiError(
        {
          code: "work_archived",
          message: "This Work is archived and read-only.",
          source: "system",
          retryable: false,
        },
        403,
      ),
    );
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        await probe().editor.controller.applyChange(change("2"));
      });
      const item = probe().header.view.items.find((entry) => entry.change.classId === "class-2");
      expect(item?.failure).toMatchObject({
        code: "refused",
        reason: "This Work is archived. Unarchive it to apply or discard its drafts.",
      });
    });
  });
});
