// @vitest-environment jsdom
/** Network answers projected through real review scopes, mutations and header models. */
import type { DraftDiscardResponse } from "@meridian/contracts/drafts";
import { notifyManager, onlineManager } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpResponseError } from "@/client/api/http-client";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  applied,
  change,
  createReviewScopeFixture,
  deferredReviewAnswer,
  draftA,
  listed,
  operation,
  preview,
  previewOf,
  type ScopeProbe,
} from "@/test-support/draft-review-scope";

let fixture: ReturnType<typeof createReviewScopeFixture>;
const draftB = { documentId: "document-b", draftId: "draft-b" };
const listedB = { ...listed, ...draftB, documentName: "Chapter 13" };
const ids = (p: ScopeProbe) => p.header.view.items.map(({ change }) => change.classId);
const failure = (p: ScopeProbe) =>
  p.header.view.items.find(({ change }) => change.classId === "class-2")?.failure;
async function open(p: () => ScopeProbe) {
  await vi.waitFor(() => expect(p().editor.files.length).toBeGreaterThan(0));
  await act(async () => p().editor.controller.enterInlineReview("document-a", "draft-a"));
  await vi.waitFor(() => expect(p().header.view.status).toBe("ready"));
}
beforeEach(() => {
  // Keep real query notification timing, but flush each scheduled React update under act.
  notifyManager.setNotifyFunction((notify) => {
    act(notify);
  });
  resetDraftCommandRecords();
  fixture = createReviewScopeFixture();
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  fixture.network.getDraftPreview.mockResolvedValue(preview);
});
afterEach(() => {
  notifyManager.setNotifyFunction((notify) => notify());
  onlineManager.setOnline(true);
  vi.useRealTimers();
  fixture.dispose();
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
  fixture.network.discardDraft.mockReturnValueOnce(answer.promise);
  await fixture.render(async (p) => {
    await open(p);
    let done!: Promise<unknown>;
    await act(async () => {
      done = p().editor.controller.discardChanges(draftA, change("2"));
    });
    expect(ids(p())).toEqual([]);
    fixture.network.getDraftPreview.mockResolvedValue({
      ...previewOf("2"),
      operations: [{ ...operation("2"), closureClassId: "class-refreshed" }],
    });
    await act(async () => {
      answer.resolve({
        status: "stale",
        draftId: "draft-a",
        draftClosed: true,
      } as DraftDiscardResponse);
      await done;
    });
    await vi.waitFor(() => expect(ids(p())).toEqual(["class-refreshed"]));
    expect(p().header.view.items[0]?.failure).toMatchObject({ code: "stale", mode: "discard" });
    expect(p().header.finished).toBe(false);
    expect(p().header.completing).toBeNull();
    expect(p().editor.controller.inlineReview?.completion).toBeUndefined();
  });
});

it("a whole batch continues after a late refusal, attributes it to the departed file and never navigates back", async () => {
  const draftC = { documentId: "document-c", draftId: "draft-c" };
  fixture.network.listWorkDrafts.mockResolvedValue({
    drafts: [listed, listedB, { ...listed, ...draftC, documentName: "Chapter 14" }],
  });
  const answer = deferredReviewAnswer<Awaited<ReturnType<typeof fixture.network.applyDraft>>>();
  fixture.network.applyDraft
    .mockReturnValueOnce(answer.promise)
    .mockResolvedValue({ status: "applied", draftId: "draft-b" });
  const navigate = vi.fn();
  await fixture.render(
    async (p) => {
      await open(p);
      let done!: Promise<unknown>;
      await act(async () => {
        done = p().editor.controller.disposeDrafts("apply", [draftA, draftB]);
      });
      await p().openDraft(draftC);
      await act(async () => p().editor.controller.enterInlineReview("document-c", "draft-c"));
      await act(async () => {
        answer.reject(new HttpResponseError("refused", 500, null));
        await done;
      });
      expect(fixture.network.applyDraft.mock.calls.map((call) => call[2])).toEqual([
        "document-a",
        "document-b",
      ]);
      await vi.waitFor(() =>
        expect(
          p().header.failedElsewhere.map(({ row, failure }) => [row.documentId, failure.code]),
        ).toEqual([["document-a", "apply-server-error"]]),
      );
      expect(p().header.commandError).toBeNull();
      expect(navigate).not.toHaveBeenCalled();
      expect(p().editor.controller.inlineReview?.draftId).toBe("draft-c");
    },
    { onOpenDraft: navigate },
  );
});

it("a batch's current-file failure leaves its review usable and unfinished", async () => {
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [listed, listedB] });
  fixture.network.applyDraft
    .mockRejectedValueOnce(new HttpResponseError("refused", 500, null))
    .mockResolvedValue({ status: "applied", draftId: "draft-b" });
  await fixture.render(async (p) => {
    await open(p);
    await act(async () => {
      await p().editor.controller.disposeDrafts("apply", [draftA, draftB]);
    });
    expect(p().header.commandError).toEqual({ code: "apply-server-error" });
    expect(p().header.finished).toBe(false);
    expect(p().header.completing).toBeNull();
    expect(p().editor.controller.inlineReview).toMatchObject({ draftId: "draft-a" });
    expect(p().editor.controller.inlineReview?.completion).toBeUndefined();
    expect(fixture.network.applyDraft.mock.calls.map((call) => call[2])).toEqual([
      "document-a",
      "document-b",
    ]);
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
        ? p().editor.controller.applyChanges
        : p().editor.controller.discardChanges)(draftA, change("2"));
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
] as const)("lost selective %s answer is unknown, not an offline click or refusal", async (mode) => {
  const endpoint =
    mode === "apply" ? fixture.network.applyDraftChanges : fixture.network.discardDraft;
  endpoint.mockRejectedValue(new TypeError("Failed to fetch"));
  await fixture.render(async (p) => {
    await open(p);
    await act(async () => {
      const outcome = await (mode === "apply"
        ? p().editor.controller.applyChanges
        : p().editor.controller.discardChanges)(draftA, change("2"));
      expect(outcome).toEqual({ kind: "change-refused", mode, code: "unknown" });
    });
    expect(ids(p())).toEqual(["class-1", "class-2"]);
    expect(failure(p())).toMatchObject({ mode, code: "unknown" });
    expect(endpoint).toHaveBeenCalledTimes(1);
    expect(p().header.finished).toBe(false);
  });
});

it("an HTTP Discard refusal restores the change as server-error rather than unknown", async () => {
  fixture.network.discardDraft.mockRejectedValue(new HttpResponseError("refused", 500, null));
  await fixture.render(async (p) => {
    await open(p);
    await act(async () => {
      await p().editor.controller.discardChanges(draftA, change("2"));
    });
    expect(failure(p())).toMatchObject({ code: "server-error", mode: "discard" });
    expect(ids(p())).toEqual(["class-1", "class-2"]);
  });
});

it.each([
  "applyDraft",
  "discardDraft",
] as const)("offline header %s stays here and reconnect dispatches neither real export", async (command) => {
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [listed, listedB] });
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
      expect(p().editor.controller.inlineReview?.draftId).toBe("draft-a");
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
it("classified commands never hide or send an unowned hunk, which prevents completion", async () => {
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
    expect(p().header.view.items.map(({ change }) => change.actionable)).toEqual([true, false]);
    const unowned = p().header.view.items[1].change;
    await act(async () => {
      await p().header.view.apply(unowned);
      await p().header.view.discard(unowned);
    });
    expect(fixture.network.applyDraftChanges).not.toHaveBeenCalled();
    expect(fixture.network.discardDraft).not.toHaveBeenCalled();
    let done!: Promise<unknown>;
    await act(async () => {
      done = p().editor.controller.applyChanges(draftA, change("1"));
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
    expect(p().editor.controller.inlineReview?.completion).toBeUndefined();
  });
});

it("formatting residue after the last class is not completion and keeps whole commands available", async () => {
  fixture.network.getDraftPreview.mockResolvedValue(previewOf("1"));
  fixture.network.applyDraftChanges.mockResolvedValue(applied(false, "1"));
  await fixture.render(async (p) => {
    await open(p);
    fixture.network.getDraftPreview.mockResolvedValue({ ...preview, operations: [], hunks: [] });
    await act(async () => {
      await p().editor.controller.applyChanges(draftA, change("1"));
    });
    await vi.waitFor(() => expect(p().header.unlisted).toBe(true));
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
      await p().editor.controller.applyChanges(draftA, change("1"));
    });
    await vi.waitFor(() => expect(p().header.finished).toBe(true));
    expect(p().header.unlisted).toBe(false);
  });
});
