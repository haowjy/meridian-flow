// @vitest-environment jsdom
/** Draft authority across real Editor/Chat scopes and immutable Work-bound batches. */
import { notifyManager } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpResponseError, MeridianApiError } from "@/client/api/http-client";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  applied,
  change,
  createReviewScopeFixture,
  deferredReviewAnswer,
  discarded,
  draftA,
  listed,
  previewOf,
  type ScopeProbe,
  workC,
} from "@/test-support/draft-review-scope";

let fixture: ReturnType<typeof createReviewScopeFixture>;
const draftB = { documentId: "document-b", draftId: "draft-b" };
const listedB = { ...listed, ...draftB, documentName: "Chapter 13" };
const target = (draft: typeof draftA) => ({ projectId: "project-a", workId: "work-a", ...draft });
async function open(p: () => ScopeProbe, draft = draftA) {
  await act(async () => p().editor.controller.enterInlineReview(draft.documentId, draft.draftId));
  await p().openDraft(draft);
  await vi.waitFor(() => expect(p().header.view.status).toBe("ready"));
}
beforeEach(() => {
  // Keep real query notification timing, but flush each scheduled React update under act.
  notifyManager.setNotifyFunction((notify) => {
    act(notify);
  });
  resetDraftCommandRecords();
  fixture = createReviewScopeFixture();
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [listed, listedB] });
  fixture.network.getDraftPreview.mockImplementation(async (_p, _w, _d, id) => ({
    ...previewOf(...(id === "draft-b" ? ["3"] : ["1", "2"])),
    draftId: id,
  }));
});
afterEach(() => {
  notifyManager.setNotifyFunction((notify) => notify());
  vi.restoreAllMocks();
  fixture.dispose();
});

it("Editor selective Apply excludes Chat whole commands and both surfaces display busy", async () => {
  const answer = deferredReviewAnswer<ReturnType<typeof applied>>();
  fixture.network.applyDraftChanges.mockReturnValueOnce(answer.promise);
  await fixture.render(async (p) => {
    await open(p);
    let done!: Promise<unknown>;
    await act(async () => {
      done = p().editor.controller.applyChanges(draftA, change("2"));
    });
    expect(p().editor.controller.isDisposing).toBe(true);
    expect(p().chat.controller.dispositionLocked).toBe(true);
    await act(async () => {
      expect(await p().chat.controller.apply("document-a", "draft-a")).toEqual({ kind: "blocked" });
      expect(await p().chat.controller.discard("document-a", "draft-a")).toEqual({
        kind: "blocked",
      });
    });
    expect(fixture.network.applyDraft).not.toHaveBeenCalled();
    expect(fixture.network.discardDraft).not.toHaveBeenCalled();
    await act(async () => {
      answer.resolve(applied(false));
      await done;
    });
    expect(p().chat.controller.isDisposing).toBe(false);
    expect(fixture.network.applyDraftChanges).toHaveBeenCalledTimes(1);
  });
});

it("Chat whole Apply excludes Editor selection without hiding the blocked change", async () => {
  const answer = deferredReviewAnswer<Awaited<ReturnType<typeof fixture.network.applyDraft>>>();
  fixture.network.applyDraft.mockReturnValueOnce(answer.promise);
  await fixture.render(async (p) => {
    await open(p);
    let done!: Promise<unknown>;
    await act(async () => {
      done = p().chat.controller.apply("document-a", "draft-a");
    });
    expect(p().header.locked).toBe(true);
    await act(async () => {
      expect(await p().editor.controller.applyChanges(draftA, change("2"))).toEqual({
        kind: "blocked",
      });
    });
    expect(fixture.network.applyDraftChanges).not.toHaveBeenCalled();
    expect(p().header.view.items.map(({ change }) => change.classId)).toEqual([
      "class-1",
      "class-2",
    ]);
    await act(async () => {
      answer.resolve({ status: "applied", draftId: "draft-a" });
      await done;
    });
  });
});

it("typed refusal retains the server reason and category on the restored change", async () => {
  fixture.network.applyDraftChanges.mockRejectedValue(
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
  await fixture.render(async (p) => {
    await open(p);
    await act(async () => {
      await p().header.view.apply(p().header.view.items[1].change);
    });
    expect(p().header.view.items[1]?.failure).toMatchObject({
      code: "refused",
      serverCode: "work_archived",
      serverReason: "This Work is archived and read-only.",
    });
  });
});

it.each([
  false,
  true,
])("late failure belongs to its draft after navigating away (returned: %s)", async (returned) => {
  const answer = deferredReviewAnswer<ReturnType<typeof applied>>();
  fixture.network.applyDraftChanges.mockReturnValueOnce(answer.promise);
  await fixture.render(async (p) => {
    await open(p);
    const viewA = await p().mountDraftChanges(target(draftA));
    let done!: Promise<unknown>;
    await act(async () => {
      done = p().editor.controller.applyChanges(draftA, change("2"));
    });
    await open(p, draftB);
    if (returned) await open(p);
    await act(async () => {
      answer.reject(new HttpResponseError("refused", 500, null));
      await done;
    });
    await vi.waitFor(() =>
      expect(
        viewA().items.find(({ change }) => change.classId === "class-2")?.failure,
      ).toMatchObject({ code: "server-error" }),
    );
    expect(p().editor.controller.inlineReview?.draftId).toBe(returned ? "draft-a" : "draft-b");
    if (returned) expect(p().header.view.items[1]?.failure).toMatchObject({ code: "server-error" });
    else expect(p().header.view.items.every(({ failure }) => failure === null)).toBe(true);
    expect(p().editor.controller.toast).toBeNull();
  });
});

it.each([
  ["apply", false],
  ["apply", true],
  ["discard", true],
] as const)("%s batch keeps original Work with first draft in Editor: %s", async (mode, editorFirst) => {
  const applyAnswer = deferredReviewAnswer<ReturnType<typeof applied>>();
  const discardAnswer = deferredReviewAnswer<ReturnType<typeof discarded>>();
  const endpoint =
    mode === "apply" ? fixture.network.applyDraftChanges : fixture.network.discardDraft;
  if (mode === "apply") fixture.network.applyDraftChanges.mockReturnValueOnce(applyAnswer.promise);
  else fixture.network.discardDraft.mockReturnValueOnce(discardAnswer.promise);
  await fixture.render(async (p) => {
    await vi.waitFor(() => expect(p().chat.files).toHaveLength(2));
    if (editorFirst) await open(p);
    const viewA = await p().mountDraftChanges(target(draftA));
    const viewB = await p().mountDraftChanges(target(draftB));
    await vi.waitFor(() => expect([viewA().status, viewB().status]).toEqual(["ready", "ready"]));
    let done!: Promise<unknown>;
    await act(async () => {
      done = (mode === "apply" ? p().chatRunner.applyBatch : p().chatRunner.discardBatch)([
        { draft: draftA, selection: change("2") },
        { draft: draftB, selection: change("3") },
      ]);
    });
    expect(endpoint).toHaveBeenCalledTimes(1);
    await p().moveChatToWork(workC);
    if (mode === "apply")
      fixture.network.applyDraftChanges.mockResolvedValue({
        ...applied(false, "3"),
        draftId: "draft-b",
      });
    else
      fixture.network.discardDraft.mockResolvedValue({ ...discarded(false), draftId: "draft-b" });
    await act(async () => {
      if (mode === "apply") applyAnswer.resolve(applied(false));
      else discardAnswer.resolve(discarded(false));
      await done;
    });
    expect(endpoint.mock.calls.map((call) => [call[1], call[2], call[3].draftId])).toEqual([
      ["work-a", "document-a", "draft-a"],
      ["work-a", "document-b", "draft-b"],
    ]);
    expect(p().chat.controller.workId).toBe("work-c");
  });
});

it("a rejected cache dependency restores every queued selection and a subsequent real batch runs", async () => {
  await fixture.render(async (p) => {
    const viewA = await p().mountDraftChanges(target(draftA));
    const viewB = await p().mountDraftChanges(target(draftB));
    await vi.waitFor(() => expect([viewA().status, viewB().status]).toEqual(["ready", "ready"]));
    const read = vi.spyOn(p().queryClient, "getQueryData").mockImplementationOnce(() => {
      throw new Error("cache unavailable");
    });
    const batch = [
      { draft: draftA, selection: change("2") },
      { draft: draftB, selection: change("3") },
    ];
    await act(async () => {
      await expect(p().chatRunner.applyBatch(batch)).rejects.toThrow("cache unavailable");
    });
    read.mockRestore();
    expect(fixture.network.applyDraftChanges).not.toHaveBeenCalled();
    expect(viewA().items.map(({ change }) => change.classId)).toEqual(["class-1", "class-2"]);
    expect(viewB().items.map(({ change }) => change.classId)).toEqual(["class-3"]);
    fixture.network.applyDraftChanges.mockResolvedValue(applied(false));
    await act(async () => {
      await p().chatRunner.applyBatch(batch);
    });
    expect(fixture.network.applyDraftChanges.mock.calls.map((call) => call[2])).toEqual([
      "document-a",
      "document-b",
    ]);
  });
});
