// @vitest-environment jsdom
/** Draft authority across real presented-review/Chat scopes and immutable Work-bound batches. */

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
import { settleReact } from "@/test-support/react-dom-harness";

let fixture: ReturnType<typeof createReviewScopeFixture>;
const draftB = { documentId: "document-b", draftId: "draft-b" };
const listedB = { ...listed, ...draftB, documentName: "Chapter 13" };
const target = (draft: typeof draftA) => ({ projectId: "project-a", workId: "work-a", ...draft });
async function open(p: () => ScopeProbe, draft = draftA) {
  await act(async () =>
    p().presented.controller.enterInlineReview(draft.documentId, draft.draftId),
  );
  await p().openDraft(draft);
  await settleReact(() => expect(p().header.view.status).toBe("ready"));
}
beforeEach(() => {
  vi.useFakeTimers();
  resetDraftCommandRecords();
  fixture = createReviewScopeFixture();
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [listed, listedB] });
  fixture.network.getDraftPreview.mockImplementation(async (_p, _w, _d, id) => ({
    ...previewOf(...(id === "draft-b" ? ["3"] : ["1", "2"])),
    draftId: id,
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fixture.dispose();
});

it("Chat whole Apply hides the draft and excludes presented review selection", async () => {
  const answer = deferredReviewAnswer<Awaited<ReturnType<typeof fixture.network.applyDraft>>>();
  fixture.network.applyDraft.mockReturnValueOnce(answer.promise);
  await fixture.render(async (p) => {
    await open(p);
    let done!: Promise<unknown>;
    await act(async () => {
      done = p().chat.commands.apply("document-a", "draft-a");
    });
    expect(p().header.locked).toBe(true);
    await act(async () => {
      expect(await p().presented.controller.applyChanges(draftA, change("2"))).toEqual({
        kind: "blocked",
      });
    });
    expect(fixture.network.applyDraftChanges).not.toHaveBeenCalled();
    expect(p().header.view.items).toEqual([]);
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
      done = p().presented.controller.applyChanges(draftA, change("2"));
    });
    await open(p, draftB);
    if (returned) await open(p);
    await act(async () => {
      answer.reject(new HttpResponseError("refused", 500, null));
      await done;
    });
    await settleReact(() =>
      expect(
        viewA().items.find(({ change }) => change.classId === "class-2")?.failure,
      ).toMatchObject({ code: "server-error" }),
    );
    expect(p().presented.controller.inlineReview?.draftId).toBe(returned ? "draft-a" : "draft-b");
    if (returned) expect(p().header.view.items[1]?.failure).toMatchObject({ code: "server-error" });
    else expect(p().header.view.items.every(({ failure }) => failure === null)).toBe(true);
    expect(p().presented.controller.toast).toBeNull();
  });
});

it.each([
  ["apply", false],
  ["apply", true],
  ["discard", true],
] as const)("%s batch keeps original Work with first draft in presented review: %s", async (mode, presentedFirst) => {
  const applyAnswer = deferredReviewAnswer<ReturnType<typeof applied>>();
  const discardAnswer = deferredReviewAnswer<ReturnType<typeof discarded>>();
  const endpoint =
    mode === "apply" ? fixture.network.applyDraftChanges : fixture.network.discardDraft;
  if (mode === "apply")
    fixture.network.applyDraftChanges
      .mockReturnValueOnce(applyAnswer.promise)
      .mockResolvedValue({ ...applied(false, "3"), draftId: "draft-b" });
  else
    fixture.network.discardDraft
      .mockReturnValueOnce(discardAnswer.promise)
      .mockResolvedValue({ ...discarded(false), draftId: "draft-b" });
  await fixture.render(async (p) => {
    await settleReact(() => expect(p().chat.files).toHaveLength(2));
    if (presentedFirst) await open(p);
    const viewA = await p().mountDraftChanges(target(draftA));
    const viewB = await p().mountDraftChanges(target(draftB));
    await settleReact(() => expect([viewA().status, viewB().status]).toEqual(["ready", "ready"]));
    const displayedAddress = { ...draftB, projectId: "display-project", workId: "display-work" };
    let done!: Promise<unknown>;
    await act(async () => {
      done = (mode === "apply" ? p().chatRunner.applyBatch : p().chatRunner.discardBatch)([
        { draft: draftA, target: { kind: "operations" as const, selection: change("2") } },
        {
          draft: displayedAddress,
          target: { kind: "operations" as const, selection: change("3") },
        },
      ]);
    });
    expect(endpoint).toHaveBeenCalledTimes(2);
    await p().moveChatToWork(workC);
    await act(async () => {
      if (mode === "apply") applyAnswer.resolve(applied(false));
      else discardAnswer.resolve(discarded(false));
      await done;
    });
    expect(endpoint.mock.calls.map((call) => [call[1], call[2], call[3].draftId])).toEqual([
      ["work-a", "document-a", "draft-a"],
      ["work-a", "document-b", "draft-b"],
    ]);
    expect(p().chat.commands.workId).toBe("work-c");
  });
});

it("a slow refused whole command on chapter A leaves chapter B actionable", async () => {
  const answer = deferredReviewAnswer<{ status: "applied"; draftId: string }>();
  fixture.network.applyDraft.mockReturnValueOnce(answer.promise);
  await fixture.render(async (p) => {
    const viewB = await p().mountDraftChanges(target(draftB));
    await settleReact(() => expect(viewB().status).toBe("ready"));
    let done!: Promise<unknown>;
    await act(async () => {
      done = p().chat.commands.apply(draftA.documentId, draftA.draftId);
    });
    expect(viewB().locked).toBe(false);
    fixture.network.applyDraftChanges.mockResolvedValueOnce({
      ...applied(false, "3"),
      draftId: "draft-b",
    });
    await act(async () => {
      await viewB().apply(viewB().items[0].change);
    });
    expect(fixture.network.applyDraftChanges.mock.calls.map((call) => call[2])).toEqual([
      "document-b",
    ]);
    await act(async () => {
      answer.reject(new HttpResponseError("refused", 500, null));
      await done;
    });
    expect(viewB().locked).toBe(false);
  });
});
