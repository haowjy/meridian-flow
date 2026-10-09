// @vitest-environment jsdom
/**
 * The composer strip shows only this chat's changes. Real provider, scopes,
 * controllers, mutations and query cache (`renderReviewScopes`); the network and
 * the Editor handoff are the only fakes. The chat is `thread-a` ("Pacing pass").
 */
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  arcOne,
  button,
  click,
  draftItem,
  expand,
  lore,
  noWork,
  op,
  openWork,
  pacing,
  previews,
  readPreview,
  renderStrip,
  resetServer,
  serverHolds,
  strip,
  stripShows,
  text,
} from "@/test-support/draft-dock-strip";
import { applied, discarded } from "@/test-support/draft-review-scope";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  applyDraftChanges: vi.fn(),
  discardDraft: vi.fn(),
  retainBranchRooms: vi.fn(),
  openAiDraft: vi.fn(),
}));

vi.mock("@/client/api/drafts-api", () => mocks);
vi.mock("@/features/project/dock/useAiDraftLauncher", () => ({
  useAiDraftLauncher: () => ({ openAiDraft: mocks.openAiDraft }),
}));
vi.mock("@/client/query/useContextCatalog", () => ({
  contextCatalogScope: () => ({ kind: "project", projectId: "project-a" }),
  useContextCatalogView: () => ({ catalog: null }),
  projectCatalogView: () => ({ findDocument: () => null }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({ promoteAppliedDraft: vi.fn(), discardDraft: vi.fn() }),
  useOptionalAccountResourceReplica: () => null,
  useLiveDocumentSessionRegistry: () => ({
    retainBranchRooms: mocks.retainBranchRooms,
    releaseBranchRooms: vi.fn(),
    getBranchRoom: () => ({ document: { on: vi.fn(), off: vi.fn() } }),
  }),
}));

const render = (run: () => Promise<void>, options?: Parameters<typeof renderStrip>[2]) =>
  renderStrip(mocks.listWorkDrafts, run, options);

describe("DraftDock chat scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDraftCommandRecords();
    resetServer();
    mocks.getDraftPreview.mockImplementation(readPreview);
  });

  it("lists only this chat's files and counts only its changes", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [
        draftItem("ch-12", "chapter-12", [pacing]),
        draftItem("ch-13", "chapter-13", [lore]),
        draftItem("ch-14", "chapter-14", [lore, pacing]),
      ],
    });
    // chapter-12: two of this chat's changes and one of the writer's.
    serverHolds("ch-12", [op("1", "pacing"), op("2", "pacing"), op("3", "writer")]);
    serverHolds("ch-13", [op("4", "lore")]);
    // chapter-14: another chat's change beside this chat's one.
    serverHolds("ch-14", [op("5", "lore"), op("6", "pacing")]);
    await render(async () => {
      await stripShows("2 documents");
      await stripShows("3 changes");
      // Another chat's draft is never read for this strip.
      expect(mocks.getDraftPreview.mock.calls.map(([, , documentId]) => documentId).sort()).toEqual(
        ["ch-12", "ch-14"],
      );
      await expand();
      expect(text()).toContain("chapter-12");
      expect(text()).toContain("chapter-14");
      expect(text()).not.toContain("chapter-13");
    });
  });

  it("shows no strip for a chat with no changes of its own, and drops a file whose preview has none", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [
        draftItem("ch-12", "chapter-12", [pacing]),
        draftItem("ch-13", "chapter-13", [lore]),
      ],
    });
    // The chat's writes in chapter-12 were overwritten: only another chat's change is left.
    serverHolds("ch-12", [op("1", "lore")]);
    serverHolds("ch-13", [op("2", "lore")]);
    await render(async () => {
      await vi.waitFor(() => expect(mocks.getDraftPreview).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(strip()).toBeNull();
    });
  });

  it("names a candidate file at once and counts only once its preview lands", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [draftItem("ch-12", "chapter-12", [pacing])],
    });
    let land!: () => void;
    mocks.getDraftPreview.mockReturnValue(
      new Promise((resolve) => {
        land = () => {
          serverHolds("ch-12", [op("1", "pacing")]);
          resolve(previews["draft-ch-12"]);
        };
      }),
    );
    await render(async () => {
      await stripShows("chapter-12");
      expect(text()).not.toMatch(/\d+ changes?/);
      await act(async () => land());
      await stripShows("1 change");
    });
  });

  it("says a change also holds another chat's edit before any click, on a collapsed strip", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [draftItem("ch-12", "chapter-12", [pacing, lore])],
    });
    serverHolds("ch-12", [
      op("1", "pacing", { classId: "class-1" }),
      op("2", "lore", { classId: "class-1" }),
    ]);
    await render(async () => {
      await stripShows("1 change also holds an edit from Lore pass. Apply and Discard take both.");
    });
  });

  it("offers only Review when none of the chat's changes can be applied one by one", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [draftItem("ch-12", "chapter-12", [pacing])],
    });
    serverHolds("ch-12", [op("1", "pacing", { canApplyOrDiscard: false })]);
    await render(async () => {
      await stripShows("1 change needs Apply draft or Discard draft.");
      expect(button("Apply")).toBeUndefined();
      expect(button("Discard")).toBeUndefined();
      expect(button("Review draft")).toBeDefined();
    });
  });

  it("leaves a new document to Review: it is not part of Apply or Discard", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [draftItem("ch-13", "chapter-13", [pacing], { isNewDocument: true })],
    });
    serverHolds("ch-13", [op("1", "pacing")]);
    await render(async () => {
      await stripShows("chapter-13 is a new document. Review it to apply.");
      expect(button("Apply")).toBeUndefined();
      expect(button("Discard")).toBeUndefined();
      expect(button("Review draft")).toBeDefined();
    });
  });

  it("Apply sends each file one command naming all of this chat's changes with both tokens", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [
        draftItem("ch-12", "chapter-12", [pacing, lore]),
        draftItem("ch-14", "chapter-14", [pacing]),
      ],
    });
    // A tie, so the union includes the other chat's operation; the writer's own change stays out.
    serverHolds("ch-12", [
      op("1", "pacing"),
      op("2", "pacing", { classId: "class-2" }),
      op("3", "lore", { classId: "class-2" }),
      op("4", "writer"),
    ]);
    serverHolds("ch-14", [op("7", "pacing")]);
    mocks.applyDraftChanges.mockImplementation(
      async (
        _p: string,
        _w: string,
        documentId: string,
        request: { draftId: string; operationIds: string[] },
      ) => ({
        ...applied(true),
        draftId: request.draftId,
        operationIds: request.operationIds,
        closureClassIds: ["class-1"],
        draftClosed: documentId === "ch-14",
      }),
    );
    await render(async () => {
      await stripShows("3 changes");
      await click("Apply");
      await vi.waitFor(() => expect(mocks.applyDraftChanges).toHaveBeenCalledTimes(2));
      expect(mocks.applyDraftChanges).toHaveBeenNthCalledWith(
        1,
        "project-a",
        "work-a",
        "ch-12",
        expect.objectContaining({
          draftId: "draft-ch-12",
          operationIds: expect.arrayContaining(["1", "2", "3"]),
          liveRevisionToken: "live-ch-12",
          draftRevisionToken: "draft-ch-12",
        }),
      );
      const first = mocks.applyDraftChanges.mock.calls[0][3].operationIds;
      expect(first).toHaveLength(3);
      expect(mocks.applyDraftChanges).toHaveBeenNthCalledWith(
        2,
        "project-a",
        "work-a",
        "ch-14",
        expect.objectContaining({
          operationIds: ["7"],
          liveRevisionToken: "live-ch-14",
          draftRevisionToken: "draft-ch-14",
        }),
      );
      // Nothing of this chat's is left; the writer's own change was never the strip's.
      await vi.waitFor(() => expect(strip()).toBeNull());
    });
  });

  it("takes every file's changes off the strip at the click, before the batch reaches them", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [
        draftItem("ch-12", "chapter-12", [pacing]),
        draftItem("ch-14", "chapter-14", [pacing]),
      ],
    });
    serverHolds("ch-12", [op("1", "pacing")]);
    serverHolds("ch-14", [op("7", "pacing")]);
    // The first file's answer never comes: the second has not been sent yet.
    mocks.applyDraftChanges.mockReturnValue(new Promise(() => {}));
    await render(async () => {
      await stripShows("2 changes");
      await click("Apply");
      expect(strip()).toBeNull();
      expect(mocks.applyDraftChanges).toHaveBeenCalledTimes(1);
    });
  });

  it("a refusal brings the changes back with the reason on their file, and the next file still runs", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [
        draftItem("ch-12", "chapter-12", [pacing]),
        draftItem("ch-14", "chapter-14", [pacing]),
      ],
    });
    serverHolds("ch-12", [op("1", "pacing")]);
    serverHolds("ch-14", [op("7", "pacing")]);
    mocks.applyDraftChanges.mockImplementation(
      async (
        _p: string,
        _w: string,
        documentId: string,
        request: { draftId: string; operationIds: string[] },
      ) => {
        if (documentId === "ch-12") return { status: "stale", draftId: request.draftId };
        return {
          ...applied(true),
          draftId: request.draftId,
          operationIds: request.operationIds,
          closureClassIds: ["class-7"],
        };
      },
    );
    await render(async () => {
      await stripShows("2 changes");
      await click("Apply");
      await vi.waitFor(() => expect(mocks.applyDraftChanges).toHaveBeenCalledTimes(2));
      await stripShows(
        "This chat's changes in chapter-12 were updated. Check them and apply again.",
      );
      expect(text()).not.toContain("chapter-14");
      expect(text()).toContain("1 change");
    });
  });

  it("shows a preview that failed on its file with Retry, never as no changes", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [draftItem("ch-12", "chapter-12", [pacing])],
    });
    mocks.getDraftPreview.mockRejectedValue(new Error("unreachable"));
    await render(async () => {
      await stripShows("Changes couldn't load.");
      expect(text()).toContain("chapter-12");
      expect(text()).not.toMatch(/\d+ changes?/);
      serverHolds("ch-12", [op("1", "pacing"), op("2", "pacing")]);
      mocks.getDraftPreview.mockImplementation(async () => previews["draft-ch-12"]);
      await click("Retry");
      await stripShows("2 changes");
    });
  });

  it("disables Apply and Discard while this chat is generating", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [draftItem("ch-12", "chapter-12", [pacing])],
    });
    serverHolds("ch-12", [op("1", "pacing")]);
    await render(
      async () => {
        await stripShows("1 change");
        expect(button("Apply")?.disabled).toBe(true);
        expect(button("Discard")?.disabled).toBe(true);
        expect(button("Review draft")?.disabled).toBe(false);
      },
      { generating: true },
    );
  });

  it("confirms Discard across several files before sending, and discards one file at once", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [
        draftItem("ch-12", "chapter-12", [pacing]),
        draftItem("ch-14", "chapter-14", [pacing]),
      ],
    });
    serverHolds("ch-12", [op("1", "pacing")]);
    serverHolds("ch-14", [op("7", "pacing")]);
    mocks.discardDraft.mockImplementation(
      async (_p: string, _w: string, _d: string, request: { draftId: string }) => ({
        ...discarded(true),
        draftId: request.draftId,
      }),
    );
    await render(async () => {
      await stripShows("2 changes");
      await click("Discard");
      expect(text()).toContain("Discard this chat's changes?");
      expect(mocks.discardDraft).not.toHaveBeenCalled();
      await click("Keep");
      expect(text()).not.toContain("Discard this chat's changes?");
      await click("Discard");
      await click("Discard");
      await vi.waitFor(() => expect(mocks.discardDraft).toHaveBeenCalledTimes(2));
      expect(mocks.discardDraft).toHaveBeenCalledWith(
        "project-a",
        "work-a",
        "ch-14",
        expect.objectContaining({ draftId: "draft-ch-14", operationIds: ["7"] }),
      );
    });
  });

  it("discards a single file's changes at once", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [draftItem("ch-12", "chapter-12", [pacing])],
    });
    serverHolds("ch-12", [op("1", "pacing")]);
    mocks.discardDraft.mockResolvedValue({ ...discarded(true), draftId: "draft-ch-12" });
    await render(async () => {
      await stripShows("1 change");
      await click("Discard");
      expect(text()).not.toContain("Discard this chat's changes?");
      await vi.waitFor(() => expect(mocks.discardDraft).toHaveBeenCalledTimes(1));
    });
  });

  it("Review opens the first file's review focused on this chat's first change", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [
        draftItem("ch-12", "chapter-12", [pacing, lore]),
        draftItem("ch-14", "chapter-14", [pacing]),
      ],
    });
    serverHolds("ch-12", [op("1", "lore"), op("2", "pacing")]);
    serverHolds("ch-14", [op("7", "pacing")]);
    await render(async () => {
      await stripShows("2 changes");
      await click("Review draft");
      expect(mocks.openAiDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          workId: "work-a",
          documentId: "ch-12",
          draftId: "draft-ch-12",
          focusOperationIds: ["2"],
        }),
      );
    });
  });

  it("ends with All changes in the Work, which opens the Work page's Files tab", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [draftItem("ch-12", "chapter-12", [pacing])],
    });
    serverHolds("ch-12", [op("1", "pacing")]);
    await render(async () => {
      await stripShows("All changes in Arc One");
      await click("All changes in Arc One");
      expect(openWork).toHaveBeenCalledTimes(1);
      expect(openWork).toHaveBeenCalledWith(
        { kind: "work-detail", workId: arcOne.id, view: "files" },
        { replace: false },
      );
    });
  });

  it("offers no Work link in No Work, which has no Work page", async () => {
    mocks.listWorkDrafts.mockResolvedValue({
      drafts: [draftItem("ch-12", "chapter-12", [pacing])],
    });
    serverHolds("ch-12", [op("1", "pacing")]);
    await render(
      async () => {
        await stripShows("1 change");
        expect(text()).not.toContain("All changes in");
      },
      { work: noWork },
    );
  });
});
