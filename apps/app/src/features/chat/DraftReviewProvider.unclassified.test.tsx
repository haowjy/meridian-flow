// @vitest-environment jsdom
/**
 * What a review counts as remaining. A difference the server could not
 * attribute (an unclassified hunk) is a change the writer still has to deal
 * with, whoever else is handled; a draft whose only remaining difference has no
 * representation at all (formatting) is not finished either. Completion still
 * comes only from the server's `draftClosed`.
 * Real provider, controller, mutations and query cache; the network is the only fake.
 */

import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  applied,
  change,
  discarded,
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
const classifiedHunk = { kind: "text", hunkId: "h-1", operationIds: ["1"], anchor, spans: [] };
const looseHunk = {
  kind: "text",
  hunkId: "h-loose",
  operationIds: [],
  unclassified: true,
  anchor,
  spans: [],
  deletedText: "Alpha",
  deletedSpans: [],
};
const previewOfClassifiedAndLoose = {
  ...preview,
  operations: [operation("1")],
  hunks: [classifiedHunk, looseHunk],
};
const previewOfLooseOnly = { ...preview, operations: [], hunks: [looseHunk] };
/** The draft differs from live only in what no hunk or operation represents. */
const previewOfFormattingOnly = { ...preview, operations: [], hunks: [] };

const kinds = (probe: ScopeProbe) =>
  probe.header.view.items.map((item) => item.change.attribution.kind);

async function reviewOpened(probe: () => ScopeProbe) {
  await vi.waitFor(() => expect(mocks.listWorkDrafts).toHaveBeenCalled());
  await act(async () => probe().editor.controller.enterInlineReview("document-a", "draft-a"));
  await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
}

function heldCommand(mock: typeof mocks.discardDraft) {
  let answer!: (response: unknown) => void;
  mock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  return (response: unknown) => answer(response);
}

describe("an unclassified hunk beside a classified change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
    mocks.getDraftPreview.mockResolvedValue(previewOfClassifiedAndLoose);
  });

  it("lists both, and only the classified one has per-change commands", async () => {
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      expect(kinds(probe())).toEqual(["ai", "unattributed"]);
      expect(probe().header.view.items.map((item) => item.change.actionable)).toEqual([
        true,
        false,
      ]);
    });
  });

  it("applying the classified change does not predict a completion", async () => {
    const answer = heldCommand(mocks.applyDraftChanges);
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      let done: Promise<unknown> | undefined;
      await act(async () => {
        done = probe().editor.controller.applyChange(change("1"));
      });
      // The unclassified hunk is still there: nothing is being completed.
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(probe().header.completing).toBeNull();
      expect(probe().header.finished).toBe(false);
      expect(kinds(probe())).toEqual(["unattributed"]);

      mocks.getDraftPreview.mockResolvedValue(previewOfLooseOnly);
      await act(async () => {
        answer(applied(false, "1"));
        await done;
      });
      await vi.waitFor(() => expect(kinds(probe())).toEqual(["unattributed"]));
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(probe().header.finished).toBe(false);
      expect(probe().header.unlisted).toBe(false);
    });
  });

  it("discarding the classified change does not predict a completion either", async () => {
    heldCommand(mocks.discardDraft);
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      await act(async () => {
        void probe().editor.controller.discardChange(change("1"));
      });
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(probe().header.completing).toBeNull();
      expect(kinds(probe())).toEqual(["unattributed"]);
    });
  });

  it("a draft with only an unclassified hunk is not finished, and offers no per-change command", async () => {
    mocks.getDraftPreview.mockResolvedValue(previewOfLooseOnly);
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      expect(kinds(probe())).toEqual(["unattributed"]);
      expect(probe().header.finished).toBe(false);
      expect(probe().header.unlisted).toBe(false);

      const loose = probe().header.view.items[0].change;
      await act(async () => {
        await probe().header.view.apply(loose);
        await probe().header.view.discard(loose);
      });
      expect(mocks.applyDraftChanges).not.toHaveBeenCalled();
      expect(mocks.discardDraft).not.toHaveBeenCalled();
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
    });
  });
});

describe("a draft whose only remaining difference is unrepresented", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  });

  it("does not read No changes left after the last change, and keeps Apply draft and Discard draft", async () => {
    mocks.getDraftPreview.mockResolvedValue({ ...preview, operations: [operation("1")] });
    mocks.applyDraftChanges.mockResolvedValue(applied(false, "1"));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      mocks.getDraftPreview.mockResolvedValue(previewOfFormattingOnly);
      await act(async () => {
        await probe().editor.controller.applyChange(change("1"));
      });
      await vi.waitFor(() => expect(probe().header.unlisted).toBe(true));
      expect(probe().header.finished).toBe(false);
      expect(probe().header.completing).toBeNull();
      expect(probe().editor.controller.inlineReview?.completion).toBeUndefined();
      expect(probe().header.locked).toBe(false);
    });
  });

  it("Apply draft and Discard draft still finish it", async () => {
    mocks.getDraftPreview.mockResolvedValue(previewOfFormattingOnly);
    mocks.discardDraft.mockResolvedValue(discarded(true));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      expect(probe().header.unlisted).toBe(true);
      await act(async () => {
        probe().header.discardDraft();
      });
      expect(mocks.discardDraft).toHaveBeenCalledWith("project-a", "work-a", "document-a", {
        draftId: "draft-a",
      });
    });
  });

  it("is finished only by the server's draftClosed", async () => {
    mocks.getDraftPreview.mockResolvedValue({ ...preview, operations: [operation("1")] });
    mocks.applyDraftChanges.mockResolvedValue(applied(true, "1"));
    await renderReviewScopes(async (probe) => {
      await reviewOpened(probe);
      mocks.getDraftPreview.mockResolvedValue(previewOfFormattingOnly);
      await act(async () => {
        await probe().editor.controller.applyChange(change("1"));
      });
      await vi.waitFor(() => expect(probe().header.finished).toBe(true));
      expect(probe().header.unlisted).toBe(false);
      expect(probe().editor.controller.inlineReview?.completion?.phase).toBe("closed");
    });
  });
});
