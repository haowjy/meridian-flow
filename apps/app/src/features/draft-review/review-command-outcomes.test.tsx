// @vitest-environment jsdom
/** Network answers projected through real review scopes, mutations and header models. */

import type { DraftDiscardResponse } from "@meridian/contracts/branches";
import { onlineManager } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { resetBranchCommandRecords } from "@/client/query/branch-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  applied,
  change,
  createReviewScopeFixture,
  deferredReviewAnswer,
  discarded,
  draftA,
  itemApplied,
  listed,
  operation,
  preview,
  previewOf,
  type ScopeProbe,
} from "@/test-support/draft-review-scope";
import { settleReact } from "@/test-support/react-dom-harness";

let fixture: ReturnType<typeof createReviewScopeFixture>;
const draftB = { documentId: "document-b", itemKey: "draft-b" };
const listedB = { ...listed, ...draftB, documentName: "Chapter 13" };
const ids = (p: ScopeProbe) => p.header.view.items.map(({ change }) => change.classId);
const failure = (p: ScopeProbe) =>
  p.header.view.items.find(({ change }) => change.classId === "class-2")?.failure;
async function open(p: () => ScopeProbe) {
  await settleReact(() => expect(p().presented.files.length).toBeGreaterThan(0));
  await act(async () => p().presented.controller.enterInlineReview("document-a", "draft-a"));
  await settleReact(() => expect(p().header.view.status).toBe("ready"));
}
beforeEach(() => {
  vi.useFakeTimers();
  resetBranchCommandRecords();
  fixture = createReviewScopeFixture();
  fixture.network.listWorkBranchDrafts.mockResolvedValue({ items: [listed] });
  fixture.network.getDraftPreview.mockResolvedValue(preview);
});
afterEach(() => {
  vi.useRealTimers();
  onlineManager.setOnline(true);
  vi.useRealTimers();
  fixture.dispose();
  vi.restoreAllMocks();
});

/** Drain reconnect notifications without an elapsed-time assumption or a repeating-loop runAllTimers. */
async function reconnect() {
  await act(async () => {
    onlineManager.setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
  });
  vi.useRealTimers();
}

it("a stale last Discard ignores bogus closure and restores the refreshed change with its reason", async () => {
  fixture.network.getDraftPreview.mockResolvedValue(previewOf("2"));
  const answer = deferredReviewAnswer<DraftDiscardResponse>();
  fixture.network.discardDraft
    .mockReturnValueOnce(answer.promise)
    .mockResolvedValue({ status: "stale", branchId: listed.branchId, itemKey: "draft-a" });
  await fixture.render(async (p) => {
    await open(p);
    let done!: Promise<unknown>;
    await act(async () => {
      done = p().presented.controller.discardChanges(draftA, change("2"));
    });
    expect(ids(p())).toEqual([]);
    fixture.network.getDraftPreview.mockResolvedValue({
      ...previewOf("2"),
      operations: [{ ...operation("2"), closureClassId: "class-refreshed" }],
    });
    await act(async () => {
      answer.resolve({
        status: "stale",
        branchId: listed.branchId,
        itemKey: "draft-a",
        itemClosed: true,
      } as DraftDiscardResponse);
      await done;
    });
    await settleReact(() => expect(ids(p())).toEqual(["class-refreshed"]));
    expect(p().header.view.items[0]?.failure).toMatchObject({ code: "stale", mode: "discard" });
    expect(p().header.finished).toBe(false);
    expect(p().header.completing).toBeNull();
    expect(p().presented.controller.inlineReview?.completion).toBeUndefined();
  });
});

it("a whole batch continues after a late refusal, attributes it to the departed file and never navigates back", async () => {
  const draftC = { documentId: "document-c", itemKey: "draft-c" };
  fixture.network.listWorkBranchDrafts.mockResolvedValue({
    items: [listed, listedB, { ...listed, ...draftC, documentName: "Chapter 14" }],
  });
  const answer = deferredReviewAnswer<Awaited<ReturnType<typeof fixture.network.applyDraft>>>();
  fixture.network.applyBranchDrafts.mockReturnValueOnce(answer.promise as never);
  const navigate = vi.fn();
  await fixture.render(
    async (p) => {
      await open(p);
      let done!: Promise<unknown>;
      await act(async () => {
        done = p().presented.controller.disposeDrafts("apply", [draftA, draftB]);
      });
      await p().openDraft(draftC);
      await act(async () => p().presented.controller.enterInlineReview("document-c", "draft-c"));
      await act(async () => {
        answer.resolve({
          status: "completed",
          branchId: listed.branchId,
          items: [
            {
              itemKey: "draft-a",
              status: "held",
              reason: { code: "path_taken", path: "/chapter" },
            },
            { itemKey: "draft-b", status: "applied", notes: [] },
          ],
        } as never);
        await done;
      });
      expect(fixture.network.applyBranchDrafts).toHaveBeenCalledTimes(1);
      await settleReact(() =>
        expect(
          p().header.failedElsewhere.map(({ row, failure }) => [row.documentId, failure.code]),
        ).toEqual([["document-a", "apply-refused"]]),
      );
      expect(p().header.commandError).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
      expect(p().presented.controller.inlineReview?.itemKey).toBe("draft-c");
    },
    { onOpenDraft: navigate },
  );
});

it("a batch's current-file failure leaves its review usable and unfinished", async () => {
  fixture.network.listWorkBranchDrafts.mockResolvedValue({ items: [listed, listedB] });
  fixture.network.applyBranchDrafts.mockRejectedValue(new HttpResponseError("refused", 500, null));
  await fixture.render(async (p) => {
    await open(p);
    await act(async () => {
      await p().presented.controller.disposeDrafts("apply", [draftA, draftB]);
    });
    expect(p().header.commandError).toEqual({ code: "apply-server-error" });
    expect(p().header.finished).toBe(false);
    expect(p().header.completing).toBeNull();
    expect(p().presented.controller.inlineReview).toMatchObject({ itemKey: "draft-a" });
    expect(p().presented.controller.inlineReview?.completion).toBeUndefined();
    expect(fixture.network.applyBranchDrafts).toHaveBeenCalledTimes(1);
  });
});

it.each([
  "apply",
  "discard",
] as const)("offline selective %s restores the selection and never queues a reconnect request", async (mode) => {
  await fixture.render(async (p) => {
    await open(p);
    vi.useFakeTimers();
    onlineManager.setOnline(false);
    await act(async () => {
      const outcome = await (mode === "apply"
        ? p().presented.controller.applyChanges
        : p().presented.controller.discardChanges)(draftA, change("2"));
      expect(outcome).toEqual({ kind: "change-refused", mode, code: "offline" });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(ids(p())).toEqual(["class-1", "class-2"]);
    expect(failure(p())).toMatchObject({ mode, code: "offline" });
    await reconnect();
    expect(fixture.network.applyDraftChanges).not.toHaveBeenCalled();
    expect(fixture.network.discardDraft).not.toHaveBeenCalled();
  });
});

it.each([
  "apply",
  "discard",
] as const)("offline whole %s batch refuses every file before reconnect", async (mode) => {
  fixture.network.listWorkBranchDrafts.mockResolvedValue({ items: [listed, listedB] });
  await fixture.render(async (p) => {
    await open(p);
    vi.useFakeTimers();
    // Browser reachability can change before TanStack receives the online/offline event.
    const reachability = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      onlineManager.setOnline(true);
      fixture.network.listWorkBranchDrafts.mockReturnValue(new Promise(() => {}));
      let outcomes: unknown;
      await act(async () => {
        void p()
          .presented.controller.disposeDrafts(mode, [draftA, draftB])
          .then((result) => {
            outcomes = result;
          });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(outcomes).toEqual([
        { kind: "failed", failure: { code: `${mode}-offline` } },
        { kind: "failed", failure: { code: `${mode}-offline` } },
      ]);
      expect(p().presented.controller.isDisposing).toBe(false);
      expect(p().presented.files).toHaveLength(2);
      reachability.mockReturnValue(true);
      await reconnect();
      expect(fixture.network.applyDraft).not.toHaveBeenCalled();
      expect(fixture.network.discardDraft).not.toHaveBeenCalled();
    } finally {
      reachability.mockRestore();
      vi.useRealTimers();
    }
  });
});

it.each([
  "apply",
  "discard",
] as const)("lost selective %s answer is unknown, not an offline click or refusal", async (mode) => {
  const endpoint =
    mode === "apply" ? fixture.network.applyDraftChanges : fixture.network.discardDraft;
  endpoint.mockRejectedValue(new TypeError("Failed to fetch"));
  await fixture.render(async (p) => {
    await open(p);
    await act(async () => {
      const done = (
        mode === "apply"
          ? p().presented.controller.applyChanges
          : p().presented.controller.discardChanges
      )(draftA, change("2"));
      await vi.advanceTimersByTimeAsync(6000);
      expect(await done).toEqual({ kind: "change-refused", mode, code: "unknown" });
    });
    expect(ids(p())).toEqual(["class-1", "class-2"]);
    expect(failure(p())).toMatchObject({ mode, code: "unknown" });
    expect(endpoint).toHaveBeenCalledTimes(4);
    expect(p().header.finished).toBe(false);
  });
});

it("an HTTP Discard refusal restores the change as server-error rather than unknown", async () => {
  fixture.network.discardDraft.mockRejectedValue(new HttpResponseError("refused", 500, null));
  await fixture.render(async (p) => {
    await open(p);
    await act(async () => {
      await p().presented.controller.discardChanges(draftA, change("2"));
    });
    expect(failure(p())).toMatchObject({ code: "server-error", mode: "discard" });
    expect(ids(p())).toEqual(["class-1", "class-2"]);
  });
});

it.each([
  "applyDraft",
  "discardDraft",
] as const)("offline header %s stays here and reconnect dispatches neither real export", async (command) => {
  fixture.network.listWorkBranchDrafts.mockResolvedValue({ items: [listed, listedB] });
  const navigate = vi.fn();
  await fixture.render(
    async (p) => {
      await open(p);
      expect(p().header.next?.documentId).toBe("document-b");
      vi.useFakeTimers();
      onlineManager.setOnline(false);
      await act(async () => {
        p().header[command]();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(p().header.commandError).toEqual({
        code: command === "applyDraft" ? "apply-offline" : "discard-offline",
      });
      expect(p().header.locked).toBe(false);
      expect(p().presented.controller.inlineReview?.itemKey).toBe("draft-a");
      expect(navigate).not.toHaveBeenCalled();
      await reconnect();
      expect(fixture.network.applyDraft).not.toHaveBeenCalled();
      expect(fixture.network.discardDraft).not.toHaveBeenCalled();
    },
    { onOpenDraft: navigate },
  );
});

const loose = {
  kind: "text" as const,
  hunkId: "loose",
  operationIds: [],
  unclassified: true,
  anchor: { relStart: "", relEnd: "" },
  spans: [],
  deletedText: "Alpha",
  deletedSpans: [],
};
it("unowned hunks retain selective commands on complete classes and prevent selective completion", async () => {
  fixture.network.getDraftPreview.mockResolvedValue({
    ...previewOf("1"),
    hunks: [
      {
        kind: "text",
        hunkId: "classified",
        operationIds: ["1"],
        anchor: { relStart: "", relEnd: "" },
        spans: [],
      },
      loose,
    ],
  });
  const answer = deferredReviewAnswer<ReturnType<typeof applied>>();
  fixture.network.applyDraftChanges.mockReturnValueOnce(answer.promise);
  await fixture.render(async (p) => {
    await open(p);
    expect(p().header.view.items).toHaveLength(2);
    const complete = p().header.view.items.find(({ change }) => change.target.kind !== "display");
    expect(complete?.change.target.kind).toBe("operations");
    expect(
      p().header.view.items.find(({ change }) => change.target.kind === "display")?.change
        .attribution.kind,
    ).toBe("unattributed");
    if (!complete) throw new Error("missing selective change");
    let done!: Promise<unknown>;
    await act(async () => {
      done = p().header.view.apply(complete.change);
    });
    expect(p().header.view.items.map(({ change }) => change.attribution.kind)).toEqual([
      "unattributed",
    ]);
    expect(p().header.completing).toBeNull();
    fixture.network.getDraftPreview.mockResolvedValue({
      ...preview,
      operations: [],
      hunks: [loose],
    });
    await act(async () => {
      answer.resolve(applied(false, "1"));
      await done;
    });
    expect(p().header.view.items.map(({ change }) => change.attribution.kind)).toEqual([
      "unattributed",
    ]);
    expect(p().header.finished).toBe(false);
    expect(p().header.unlisted).toBe(false);
    expect(p().presented.controller.inlineReview?.completion).toBeUndefined();
  });
});

it("an incomplete class leaves neighboring classes selectively actionable", async () => {
  fixture.network.getDraftPreview.mockResolvedValue({
    ...preview,
    operations: [operation("1"), { ...operation("2"), canApplyOrDiscard: false }],
  });
  fixture.network.applyDraftChanges.mockReturnValueOnce(new Promise(() => {}));
  await fixture.render(async (p) => {
    await open(p);
    const items = p().header.view.items;
    expect(items.map(({ change }) => [change.classId, change.target.kind])).toEqual([
      ["class-1", "operations"],
      ["class-2", "display"],
    ]);
    await act(async () => {
      void p().header.view.apply(items[0].change);
    });
    expect(fixture.network.applyDraftChanges).toHaveBeenCalledWith(
      "project-a",
      "work-a",
      "document-a",
      expect.objectContaining({ operationIds: ["1"] }),
    );
    expect(fixture.network.applyDraft).not.toHaveBeenCalled();
    expect(ids(p())).toEqual(["class-2"]);
  });
});

it("formatting residue after the last class is not completion and keeps whole commands available", async () => {
  fixture.network.getDraftPreview.mockResolvedValue(previewOf("1"));
  fixture.network.applyDraftChanges.mockResolvedValue(applied(false, "1"));
  await fixture.render(async (p) => {
    await open(p);
    fixture.network.getDraftPreview.mockResolvedValue({ ...preview, operations: [], hunks: [] });
    await act(async () => {
      await p().presented.controller.applyChanges(draftA, change("1"));
    });
    await settleReact(() => expect(p().header.unlisted).toBe(true));
    expect(p().header.finished).toBe(false);
    expect(p().header.locked).toBe(false);
    expect(p().header.completing).toBeNull();
  });
});

it("explicit server-certified closure finishes the last class", async () => {
  fixture.network.getDraftPreview.mockResolvedValue({ ...preview, operations: [operation("1")] });
  fixture.network.applyDraftChanges.mockResolvedValue(applied(true, "1"));
  await fixture.render(async (p) => {
    await open(p);
    fixture.network.getDraftPreview.mockResolvedValue({ ...preview, operations: [], hunks: [] });
    await act(async () => {
      await p().presented.controller.applyChanges(draftA, change("1"));
    });
    await settleReact(() => expect(p().header.finished).toBe(true));
    expect(p().header.unlisted).toBe(false);
  });
});

it.each([
  "apply",
  "discard",
] as const)("a late whole %s answer must not close the next generation already under review", async (mode) => {
  fixture.network.listWorkBranchDrafts.mockResolvedValue({ items: [listed] });
  fixture.network.getDraftPreview.mockResolvedValue(previewOf("1", "2"));
  const answer = deferredReviewAnswer<void>();
  if (mode === "apply")
    fixture.network.applyDraft.mockReturnValueOnce(answer.promise.then(() => itemApplied()));
  else fixture.network.discardDraft.mockReturnValueOnce(answer.promise.then(() => discarded(true)));

  await fixture.render(async (p) => {
    await act(async () => p().presented.controller.enterInlineReview("document-a", "draft-a"));
    await settleReact(() => expect(p().presented.controller.inlineReview?.draftGeneration).toBe(1));
    let done!: Promise<unknown>;
    await act(async () => {
      done = p().presented.controller[mode]("document-a", "draft-a");
    });
    const nextPreview = {
      ...previewOf("new"),
      draftGeneration: 2,
      reviewRoomName: "room-generation-2",
    };
    const nextRow = { ...listed, draftGeneration: 2, updatedAt: "2026-10-09T01:00:00Z" };
    fixture.network.getDraftPreview.mockResolvedValue(nextPreview);
    fixture.network.listWorkBranchDrafts.mockResolvedValue({ items: [nextRow] });
    await act(async () => {
      p().queryClient.setQueryData(
        projectQueryKeys.workDraftPreview("project-a", "work-a", "document-a", "draft-a"),
        nextPreview,
      );
      p().queryClient.setQueryData(projectQueryKeys.workBranchDrafts("project-a", "work-a"), [
        nextRow,
      ]);
    });
    await settleReact(() => expect(p().presented.controller.inlineReview?.draftGeneration).toBe(2));
    await act(async () => {
      answer.resolve();
      await done;
    });
    expect(p().presented.controller.inlineReview?.draftGeneration).toBe(2);
  });
});

it.each([
  "apply",
  "discard",
] as const)("a new document's one change dispatches whole %s", async (mode) => {
  fixture.network.listWorkBranchDrafts.mockResolvedValue({
    items: [{ ...listed, isNew: true, wholeItem: true }],
  });
  fixture.network.getDraftPreview.mockResolvedValue({
    ...preview,
    item: { ...listed, isNew: true, wholeItem: true },
  });
  fixture.network.applyDraft.mockResolvedValue(itemApplied());
  fixture.network.discardDraft.mockResolvedValue(discarded(true));
  await fixture.render(async (p) => {
    await open(p);
    expect(p().header.view.items).toHaveLength(1);
    await act(async () => {
      await p().header.view[mode](p().header.view.items[0].change);
    });
    const request = mode === "apply" ? fixture.network.applyDraft : fixture.network.discardDraft;
    expect(request).toHaveBeenCalledWith(
      "project-a",
      "work-a",
      "document-a",
      expect.objectContaining({
        branchId: listed.branchId,
        itemKey: "draft-a",
        commandId: expect.any(String),
      }),
    );
    expect(fixture.network.applyDraftChanges).not.toHaveBeenCalled();
  });
});
