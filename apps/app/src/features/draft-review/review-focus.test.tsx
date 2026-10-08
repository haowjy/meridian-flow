// @vitest-environment jsdom
/**
 * Which change is in focus, across every surface of one review: the focus lives
 * with the review (not in each reader), survives the server regrouping a class,
 * and a command's late answer cannot move it in a review opened since.
 * Real scopes, controller and query cache; the network is the only fake.
 */

import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  listed,
  operation,
  preview,
  renderReviewScopes,
  type ScopeProbe,
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

const anchor = { relStart: "", relEnd: "" };
const hunkOf = (id: string, operationIds: string[]) => ({
  kind: "text",
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
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
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
  vi.clearAllMocks();
  resetDraftCommandRecords();
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed, second] });
  mocks.getDraftPreview.mockResolvedValue(threeChanges);
});

describe("the focused change after the server regroups it", () => {
  it("is the same change for a surface mounted afterwards as for one already showing it", async () => {
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => probe().editor.controller.focusReviewChange(review, target("2")));
      expect(probe().header.view.focused?.classId).toBe("class-2");

      mocks.getDraftPreview.mockResolvedValue(regrouped);
      await act(async () => {
        await probe().queryClient.invalidateQueries({
          queryKey: projectQueryKeys.workDraftPreview(
            "project-a",
            "work-a",
            "document-a",
            "draft-a",
          ),
        });
      });
      await vi.waitFor(() => expect(probe().header.view.focused?.classId).toBe("class-2b"));

      const late = await probe().mountLateReader();
      expect(late().focused?.classId).toBe("class-2b");
      expect(late().focusedIndex).toBe(probe().header.view.focusedIndex);
    });
  });
});

describe("a change regrouped more than once", () => {
  it("is followed through each regrouping, even when the last shares nothing with the first", async () => {
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => probe().editor.controller.focusReviewChange(review, target("2")));
      const previewKey = projectQueryKeys.workDraftPreview(
        "project-a",
        "work-a",
        "document-a",
        "draft-a",
      );
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
      ] as const) {
        mocks.getDraftPreview.mockResolvedValue(next);
        await act(async () => {
          await probe().queryClient.invalidateQueries({ queryKey: previewKey });
        });
        await vi.waitFor(() => expect(probe().header.view.focused?.classId).toBe(classId));
      }
      const late = await probe().mountLateReader();
      expect(late().focused?.classId).toBe("class-2c");
    });
  });
});

describe("a command's late answer", () => {
  it("does not move focus in a review the writer opened after sending it", async () => {
    let answer!: (response: unknown) => void;
    mocks.applyDraftChanges.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await renderReviewScopes(async (probe) => {
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
        answer({ status: "stale" });
        await done;
      });
      expect(probe().editor.controller.focus).toBeNull();
    });
  });
});
