// @vitest-environment jsdom
/** Shared provider focus follows regrouping, commands and stepping; late answers cannot focus another review. */

import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  applied,
  createReviewScopeFixture,
  deferredReviewAnswer,
  listed,
  operation,
  preview,
  type ScopeProbe,
} from "@/test-support/draft-review-scope";

let fixture: ReturnType<typeof createReviewScopeFixture>;
const anchor = { relStart: "", relEnd: "" };
const hunkOf = (id: string, operationIds: string[]) => ({
  kind: "text" as const,
  hunkId: `h-${id}`,
  operationIds,
  anchor,
  spans: [],
});
const inClass = (id: string, closureClassId: string) => ({ ...operation(id), closureClassId });

const threeChanges = {
  ...preview,
  operations: [operation("1"), operation("2"), operation("3")],
  hunks: [hunkOf("1", ["1"]), hunkOf("2", ["2"]), hunkOf("3", ["3"])],
};
/** The server joined operation 5 to class 2: the class id moved, operation 2 stayed. */
const regrouped = {
  ...preview,
  operations: [operation("1"), inClass("2", "class-2b"), inClass("5", "class-2b"), operation("3")],
  hunks: [hunkOf("1", ["1"]), hunkOf("2", ["2", "5"]), hunkOf("3", ["3"])],
};

const second = { ...listed, draftId: "draft-b", documentId: "document-b" };

async function reviewOpened(probe: () => ScopeProbe) {
  await vi.waitFor(() => expect(fixture.network.listWorkDrafts).toHaveBeenCalled());
  await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
  await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
}

const review = { documentId: "document-a", draftId: "draft-a" };
const target = (id: string) => ({
  classId: `class-${id}`,
  operationIds: [id],
  anchorOperationId: id,
});

beforeEach(() => {
  fixture = createReviewScopeFixture();
  resetDraftCommandRecords();
  fixture.network.listWorkDrafts.mockResolvedValue({ drafts: [listed, second] });
  fixture.network.getDraftPreview.mockResolvedValue(threeChanges);
});

afterEach(() => fixture.dispose());

describe("a change regrouped more than once", () => {
  it("is followed through each regrouping, even when the last shares nothing with the first", async () => {
    await fixture.render(async (probe) => {
      await reviewOpened(probe);
      await act(async () => probe().editor.controller.focusReviewChange(review, target("2")));
      const previewKey = projectQueryKeys.workDraftPreview(
        "project-a",
        "work-a",
        "document-a",
        "draft-a",
      );
      let late: Awaited<ReturnType<ScopeProbe["mountLateReader"]>> | undefined;
      for (const [next, classId] of [
        [regrouped, "class-2b"],
        [
          {
            ...preview,
            operations: [operation("1"), inClass("5", "class-2c"), inClass("6", "class-2c")],
            hunks: [hunkOf("1", ["1"]), hunkOf("5", ["5", "6"])],
          },
          "class-2c",
        ],
      ] satisfies [DraftPreviewResponse, string][]) {
        fixture.network.getDraftPreview.mockResolvedValue(next);
        await act(async () => {
          await probe().queryClient.invalidateQueries({ queryKey: previewKey });
        });
        await vi.waitFor(() => expect(probe().header.view.focused?.classId).toBe(classId));
        late ??= await probe().mountLateReader();
        await vi.waitFor(() => expect(late?.().focused?.classId).toBe(classId));
        expect(late().focusedIndex).toBe(probe().header.view.focusedIndex);
      }
      expect(late?.().focused?.classId).toBe("class-2c");
    });
  });
});

describe("a command's late answer", () => {
  it("does not move focus in a review the writer opened after sending it", async () => {
    let answer!: (response: { status: "stale"; draftId: string }) => void;
    fixture.network.applyDraftChanges.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await fixture.render(async (probe) => {
      await reviewOpened(probe);
      const sent = probe().header.view.items[1].change;
      let done!: Promise<void>;
      await act(async () => {
        done = probe().header.view.apply(sent);
      });

      // The writer moves on to another draft before the server answers.
      await act(async () => probe().editor.controller.enterInlineReview("document-b", "draft-b"));
      await vi.waitFor(() =>
        expect(probe().editor.controller.inlineReview?.documentId).toBe("document-b"),
      );

      await act(async () => {
        answer({ status: "stale", draftId: "draft-a" });
        await done;
      });
      expect(probe().editor.controller.focus).toBeNull();
    });
  });
});

describe("focus through real review commands", () => {
  it("steps in document order and wraps through the shared provider focus", async () => {
    await fixture.render(async (probe) => {
      await reviewOpened(probe);
      expect(probe().header.view.focused).toBeNull();
      await act(async () => probe().header.view.step(1));
      expect(probe().header.view.focused?.classId).toBe("class-1");
      await act(async () => probe().header.view.step(-1));
      expect(probe().header.view.focused?.classId).toBe("class-3");
      await act(async () => probe().header.view.step(1));
      expect(probe().header.view.focused?.classId).toBe("class-1");
    });
  });

  it("advances after Apply and returns to the refused change with its reason", async () => {
    const accepted = deferredReviewAnswer<ReturnType<typeof applied>>();
    const refused = deferredReviewAnswer<{ status: "stale"; draftId: string }>();
    fixture.network.applyDraftChanges
      .mockReturnValueOnce(accepted.promise)
      .mockReturnValueOnce(refused.promise);
    await fixture.render(async (probe) => {
      await reviewOpened(probe);
      await act(async () => probe().header.view.focus(probe().header.view.items[1].change));
      let done!: Promise<void>;
      await act(async () => {
        done = probe().header.view.apply(probe().header.view.items[1].change);
      });
      expect(probe().header.view.focused?.classId).toBe("class-3");
      expect(fixture.network.applyDraftChanges).toHaveBeenLastCalledWith(
        "project-a",
        "work-a",
        "document-a",
        expect.objectContaining({
          draftId: "draft-a",
          operationIds: ["2"],
          liveRevisionToken: "live-1",
          draftRevisionToken: "draft-1",
        }),
      );
      fixture.network.getDraftPreview.mockResolvedValue({
        ...threeChanges,
        operations: [operation("1"), operation("3")],
        hunks: [hunkOf("1", ["1"]), hunkOf("3", ["3"])],
      });
      await act(async () => {
        accepted.resolve(applied(false));
        await done;
      });
      await vi.waitFor(() =>
        expect(probe().header.view.items.map((item) => item.change.classId)).toEqual([
          "class-1",
          "class-3",
        ]),
      );
      expect(probe().header.view.focused?.classId).toBe("class-3");

      await act(async () => probe().header.view.focus(probe().header.view.items[0].change));
      await act(async () => {
        done = probe().header.view.apply(probe().header.view.items[0].change);
      });
      expect(probe().header.view.focused?.classId).toBe("class-3");
      await act(async () => {
        refused.resolve({ status: "stale", draftId: "draft-a" });
        await done;
      });
      await vi.waitFor(() => expect(probe().header.view.focused?.classId).toBe("class-1"));
      expect(probe().header.view.items[0].failure?.code).toBe("stale");
    });
  });
});
