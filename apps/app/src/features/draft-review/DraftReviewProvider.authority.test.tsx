// @vitest-environment jsdom
/**
 * Command authority and read ownership across the review's real surfaces: the
 * Editor's and the Chat's scopes over one Work, their controllers, mutations
 * and query cache. The network is the only fake.
 */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpResponseError, MeridianApiError } from "@/client/api/http-client";
import {
  currentDraftCommandRecords,
  draftCommandFailure,
  resetDraftCommandRecords,
} from "@/client/query/draft-command-record";
import {
  applied,
  change,
  createReviewScopeFixture,
  deferredReviewAnswer,
  draftA,
  listed,
  preview,
  previewOf,
  type ScopeProbe,
  work,
} from "@/test-support/draft-review-scope";

let fixture: ReturnType<typeof createReviewScopeFixture>;
let mocks: ReturnType<typeof createReviewScopeFixture>["network"];
const renderReviewScopes: typeof fixture.render = (...args) => fixture.render(...args);

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
  fixture = createReviewScopeFixture();
  mocks = fixture.network;
  resetDraftCommandRecords();
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  mocks.getDraftPreview.mockResolvedValue(preview);
});

afterEach(() => fixture.dispose());

describe("one command authority per draft across the Editor and the Chat", () => {
  it("a per-change Apply in the Editor blocks the Chat's whole-draft Apply and Discard, and both surfaces read busy", async () => {
    const answer = deferredReviewAnswer<ReturnType<typeof applied>>();
    mocks.applyDraftChanges.mockReturnValueOnce(answer.promise);
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let done: Promise<unknown> | undefined;
      await act(async () => {
        done = probe().editor.controller.applyChanges(draftA, change("2"));
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
        answer.resolve(applied(false));
        await done;
      });
      await vi.waitFor(() => expect(probe().chat.controller.isDisposing).toBe(false));
      expect(mocks.applyDraftChanges).toHaveBeenCalledTimes(1);
    });
  });

  it("a whole-draft Apply in the Chat blocks the Editor's per-change Apply, and both surfaces read busy", async () => {
    const confirm = deferredReviewAnswer<Awaited<ReturnType<typeof mocks.applyDraft>>>();
    mocks.applyDraft.mockReturnValueOnce(confirm.promise);
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
        outcome = await probe().editor.controller.applyChanges(draftA, change("2"));
      });
      expect(outcome).toEqual({ kind: "blocked" });
      expect(mocks.applyDraftChanges).not.toHaveBeenCalled();
      // The blocked command left no trace on the change.
      expect(classIds(probe())).toEqual(["class-1", "class-2"]);

      await act(async () => {
        confirm.resolve({ status: "applied", draftId: "draft-a" });
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

      const oldRead = deferredReviewAnswer<typeof preview>();
      mocks.getDraftPreview.mockReturnValueOnce(oldRead.promise);
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      expect(probe().editor.controller.reviewRoomName).toBeNull();
      // The list is already actionable from the cache.
      await vi.waitFor(() => expect(classIds(probe())).toEqual(["class-1", "class-2"]));

      mocks.getDraftPreview.mockResolvedValue(previewOf("1"));
      await act(async () => {
        await probe().editor.controller.applyChanges(draftA, change("2"));
      });
      await vi.waitFor(() => expect(classIds(probe())).toEqual(["class-1"]));

      // The older read answers last, with the change still in it.
      await act(async () => oldRead.resolve(preview));
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
      const slow = deferredReviewAnswer<typeof preview>();
      mocks.getDraftPreview.mockReturnValueOnce(slow.promise);
      await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
      await act(async () => probe().editor.controller.exitInlineReview());
      await act(async () => slow.resolve({ ...preview, reviewRoomName: "stale-room" }));
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
    const answer = deferredReviewAnswer<Awaited<ReturnType<typeof mocks.applyDraft>>>();
    mocks.applyDraft.mockReturnValueOnce(answer.promise);
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
        answer.reject(new HttpResponseError("refused", 409, {}));
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
        await probe().editor.controller.applyChanges(draftA, change("2"));
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
        await probe().editor.controller.applyChanges(draftA, change("2"));
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
        await probe().editor.controller.applyChanges(draftA, change("2"));
      });
      const item = probe().header.view.items.find((entry) => entry.change.classId === "class-2");
      expect(item?.failure).toMatchObject({
        code: "refused",
        serverCode: "work_archived",
        serverReason: "This Work is archived and read-only.",
      });
    });
  });
});
