// @vitest-environment jsdom
/** Real provider/query/command witnesses for the room owner; HTTP is the only fake. */
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { draftPreviewQueryOptions } from "@/client/query/useDraftPreview";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import {
  applied,
  change,
  createReviewScopeFixture,
  deferredReviewAnswer,
  draftA,
  listed,
  previewOf,
  workC,
} from "@/test-support/draft-review-scope";
import { sessionFor, setConnectionState } from "@/test-support/editor-session-fakes";

let fixture: ReturnType<typeof createReviewScopeFixture>;
const previewKey = projectQueryKeys.workDraftPreview(
  "project-a",
  "work-a",
  "document-a",
  "draft-a",
);
const listKey = projectQueryKeys.workDrafts("project-a", "work-a");
const proposal = (generation: number, ...ids: string[]) => ({
  ...previewOf(...ids),
  draftGeneration: generation,
  reviewRoomName: `room-g${generation}`,
});
async function settled(check: () => void) {
  for (let i = 0; i < 40; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    try {
      check();
      return;
    } catch (error) {
      if (i === 39) throw error;
    }
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  resetDraftCommandRecords();
  fixture = createReviewScopeFixture();
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  fixture.network.getDraftPreview.mockResolvedValue(proposal(1, "1", "2"));
});
afterEach(() => {
  fixture.dispose();
  vi.useRealTimers();
});

it("joins a cancelled room read's replacement, and only a real failure requires re-entry", async () => {
  const first = deferredReviewAnswer<ReturnType<typeof proposal>>();
  fixture.network.getDraftPreview.mockReturnValue(new Promise(() => {}));
  fixture.network.getDraftPreview.mockReturnValueOnce(first.promise);
  await fixture.render(async (probe) => {
    await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
    expect(probe().editor.controller.reviewRoomName).toBeNull();
    for (let cancelled = 0; cancelled < 7; cancelled++) {
      await act(async () => {
        await probe().queryClient.cancelQueries({ queryKey: previewKey });
      });
    }
    fixture.network.getDraftPreview.mockResolvedValue(proposal(1, "1", "2"));
    await act(async () => {
      await probe().queryClient.cancelQueries({ queryKey: previewKey });
    });
    await settled(() => expect(probe().editor.controller.reviewRoomName).toBe("room-g1"));
    expect(probe().editor.controller.reviewRoomError).toBe(false);
    await act(async () => probe().editor.controller.exitInlineReview());
    fixture.network.getDraftPreview.mockRejectedValue(new Error("offline"));
    await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
    await settled(() => expect(probe().editor.controller.reviewRoomError).toBe(true));
    fixture.network.getDraftPreview.mockResolvedValue(proposal(1, "1", "2"));
    await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
    await settled(() => expect(probe().editor.controller.reviewRoomName).toBe("room-g1"));
  });
});

it.each([
  "navigation",
  "Work",
  "account",
] as const)("ignores a held room answer after %s changes", async (horizon) => {
  const slow = deferredReviewAnswer<ReturnType<typeof proposal>>();
  fixture.network.getDraftPreview.mockReturnValueOnce(slow.promise);
  await fixture.render(async (probe) => {
    const controller = probe().editor.controller;
    await act(async () => controller.enterInlineReview("document-a", "draft-a"));
    if (horizon === "Work") {
      await probe().moveEditorToWork(workC);
      expect(
        fixture.network.getDraftPreview.mock.calls.some(
          ([, requestedWork]) => requestedWork === workC.id,
        ),
      ).toBe(false);
    } else await act(async () => controller.exitInlineReview());
    if (horizon === "account") {
      // Closing the account destroys its query cache and retires its claims.
      await act(async () => {
        probe().queryClient.clear();
        resetDraftCommandRecords();
      });
    }
    await act(async () => slow.resolve(proposal(7, "9")));
    await settled(() => expect(probe().editor.controller.inlineReview).toBeNull());
    expect(probe().editor.roomOwner.session).toBeNull();
  });
});

it("a newer proposal beats the old command and a lagging list, with monotonic cache reads", async () => {
  const answer = deferredReviewAnswer<ReturnType<typeof applied>>();
  fixture.network.applyDraftChanges.mockReturnValue(answer.promise);
  await fixture.render(async (probe) => {
    await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
    await settled(() => expect(probe().header.view.status).toBe("ready"));
    await settled(() => expect(probe().editor.roomOwner.session).not.toBeNull());
    let done!: Promise<unknown>;
    await act(async () => {
      done = probe().editor.controller.applyChanges(draftA, change("1", "2"));
    });
    expect(probe().editor.controller.inlineReview?.completion?.phase).toBe("pending");
    const next = proposal(2, "3");
    fixture.network.getDraftPreview.mockResolvedValue(next);
    fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [] });
    await act(async () => {
      probe().queryClient.setQueryData(previewKey, next);
      probe().queryClient.setQueryData(listKey, []);
    });
    await settled(() => expect(probe().editor.controller.inlineReview?.draftGeneration).toBe(2));
    expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
    await act(async () => {
      answer.resolve(applied(true));
      await done;
    });
    expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
    await act(async () => probe().queryClient.setQueryData(previewKey, proposal(1, "old")));
    expect(probe().queryClient.getQueryData(previewKey)).toEqual(next);
    const refreshed = proposal(2, "3", "4");
    fixture.network.getDraftPreview.mockResolvedValue(refreshed);
    await act(async () => probe().queryClient.setQueryData(previewKey, refreshed));
    await settled(() =>
      expect(probe().header.view.items.map((item) => item.change.classId)).toEqual([
        "class-3",
        "class-4",
      ]),
    );
  });
});

it("a room-opening read cannot resurrect a change confirmed while the read waited", async () => {
  fixture.network.applyDraftChanges.mockResolvedValue(applied(false));
  await fixture.render(async (probe) => {
    await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
    await settled(() => expect(probe().header.view.status).toBe("ready"));
    await settled(() => expect(probe().editor.controller.reviewRoomName).toBe("room-g1"));
    await act(async () => probe().editor.controller.exitInlineReview());
    const slow = deferredReviewAnswer<ReturnType<typeof proposal>>();
    fixture.network.getDraftPreview.mockReturnValueOnce(slow.promise);
    await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
    fixture.network.getDraftPreview.mockResolvedValue(proposal(1, "1"));
    await act(async () => {
      await probe().editor.controller.applyChanges(draftA, change("2"));
    });
    expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
    await act(async () => slow.resolve(proposal(1, "1", "2")));
    await settled(() =>
      expect(probe().header.view.items.map((item) => item.change.classId)).toEqual(["class-1"]),
    );
    await settled(() => expect(probe().editor.controller.reviewRoomName).toBe("room-g1"));
  });
});

it("a late paint receipt cannot revoke the current session's input", async () => {
  await fixture.render(async (probe) => {
    await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
    await settled(() => expect(probe().editor.roomOwner.session).not.toBeNull());
    const old = probe().editor.roomOwner.session;
    const next = proposal(2, "3");
    fixture.network.getDraftPreview.mockResolvedValue(next);
    await act(async () => probe().queryClient.setQueryData(previewKey, next));
    await settled(() => expect(probe().editor.roomOwner.session?.roomKey).toBe("room-g2"));
    const current = probe().editor.roomOwner.session;
    if (!old || !current) throw new Error("Missing session");
    await act(async () => probe().editor.roomOwner.reportPaint(current));
    expect(probe().editor.roomOwner.inputEligible).toBe(true);
    await act(async () => probe().editor.roomOwner.reportPaint(old));
    expect(probe().editor.roomOwner.inputEligible).toBe(true);
  });
});

it("lets the entry read answer before a stale empty list can exit review", async () => {
  const read = deferredReviewAnswer<ReturnType<typeof proposal>>();
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [] });
  fixture.network.getDraftPreview.mockReturnValue(read.promise);
  await fixture.render(async (probe) => {
    probe().queryClient.setQueryData(listKey, []);
    await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
    expect(probe().editor.controller.inlineReview?.draftId).toBe("draft-a");
    await act(async () => read.resolve(proposal(1, "1")));
    await settled(() => expect(probe().editor.controller.reviewRoomName).toBe("room-g1"));
  });
});

it.each([false, true])("a gone entry read is authoritative (draft-only: %s)", async (draftOnly) => {
  fixture.network.listWorkDrafts.mockReturnValue(new Promise(() => {}));
  fixture.network.getDraftPreview.mockResolvedValue({ status: "gone", draftId: "draft-a" });
  await fixture.render(async (probe) => {
    if (draftOnly) probe().queryClient.setQueryData(listKey, [{ ...listed, isNewDocument: true }]);
    await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
    await settled(() =>
      draftOnly
        ? expect(probe().editor.controller.reviewRoomError).toBe(true)
        : expect(probe().editor.controller.inlineReview).toBeNull(),
    );
  });
});

it("reconsiders a protected HTTP 404 when writer carry evidence is withdrawn", async () => {
  fixture.dispose();
  let writerChanges!: (generation: number | null) => void;
  fixture = createReviewScopeFixture({
    registry: {
      retainBranchRooms: (
        _owner: string,
        refs: Parameters<LiveDocumentSessionRegistry["retainBranchRooms"]>[1],
      ) => {
        const report = refs[0]?.writerChanges;
        if (!report) throw new Error("Missing retained writer callback");
        writerChanges = report;
      },
      releaseBranchRooms: () => {},
      getBranchRoom: sessionFor,
    } as unknown as LiveDocumentSessionRegistry,
  });
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  fixture.network.getDraftPreview.mockResolvedValue(proposal(1, "1"));
  await fixture.render(async (probe) => {
    await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
    await settled(() => expect(probe().editor.roomOwner.session?.roomKey).toBe("room-g1"));
    await act(async () => writerChanges(1));
    fixture.network.getDraftPreview.mockRejectedValue(
      Object.assign(new Error("gone"), { status: 404 }),
    );
    await act(async () =>
      setConnectionState("room-g1", {
        kind: "reset",
        reason: "branch-generation-stale",
        disposition: "superseded",
      }),
    );
    await settled(() =>
      expect(probe().queryClient.getQueryState(previewKey)?.fetchStatus).toBe("idle"),
    );
    expect(probe().queryClient.getQueryData(previewKey)).toEqual({
      status: "gone",
      draftId: "draft-a",
      draftGeneration: 1,
    });
    expect(probe().queryClient.getQueryData(listKey)).toEqual([listed]);
    expect(probe().editor.controller.inlineReview?.draftGeneration).toBe(1);
    expect(probe().editor.controller.reviewRoomName).toBeNull();
    expect(probe().editor.controller.reviewRoomError).toBe(false);
    const reads = fixture.network.getDraftPreview.mock.calls.length;
    await act(async () => writerChanges(null));
    await settled(() => expect(probe().editor.controller.inlineReview).toBeNull());
    expect(fixture.network.getDraftPreview).toHaveBeenCalledTimes(reads);
  });
});

it("a late HTTP 404 retains its request-start horizon behind a newer cached proposal", async () => {
  await fixture.render(async (probe) => {
    await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
    await settled(() => expect(probe().editor.controller.reviewRoomName).toBe("room-g1"));
    const absent = deferredReviewAnswer<ReturnType<typeof proposal>>();
    fixture.network.getDraftPreview.mockReturnValueOnce(absent.promise);
    let read!: Promise<unknown>;
    await act(async () => {
      read = probe().queryClient.fetchQuery({
        ...draftPreviewQueryOptions({
          projectId: "project-a",
          workId: "work-a",
          ...draftA,
          draftGeneration: 1,
        }),
        staleTime: 0,
      });
    });
    const next = proposal(2, "3");
    fixture.network.getDraftPreview.mockResolvedValue(next);
    await act(async () => probe().queryClient.setQueryData(previewKey, next));
    await settled(() => expect(probe().editor.controller.inlineReview?.draftGeneration).toBe(2));
    await act(async () => {
      absent.reject(Object.assign(new Error("gone"), { status: 404 }));
      await read;
    });
    expect(probe().queryClient.getQueryData(previewKey)).toEqual(next);
    expect(probe().editor.controller.inlineReview?.draftGeneration).toBe(2);
  });
});
