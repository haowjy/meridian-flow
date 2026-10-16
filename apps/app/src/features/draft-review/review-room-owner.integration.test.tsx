// @vitest-environment jsdom
/** Real provider/query/command witnesses for the room owner; HTTP is the only fake. */

import type { DraftApplyChangesResponse, DraftPreviewResponse } from "@meridian/contracts/drafts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useContextTabsStore } from "@/client/stores";
import type { DocumentSessionConnectionState } from "@/core/editor/document-session";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { useDockDocumentStore } from "@/features/project/dock/dock-document-store";
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
import { createEditorSessions } from "@/test-support/editor-sessions";
import { settleReact } from "@/test-support/react-dom-harness";

describe("room owner", () => {
  let fixture: ReturnType<typeof createReviewScopeFixture>;
  let sessions: ReturnType<typeof createEditorSessions>;
  beforeEach(() => {
    sessions = createEditorSessions();
  });
  afterEach(async () => {
    await sessions.dispose();
  });

  const previewKey = projectQueryKeys.workDraftPreview(
    "project-a",
    "work-a",
    "document-a",
    "draft-a",
  );
  const listKey = projectQueryKeys.workDrafts("project-a", "work-a");
  const proposal = (generation: number, ...ids: string[]) => ({
    ...previewOf(...ids),
    branchGeneration: generation,
    reviewRoomName: `room-g${generation}`,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    resetDraftCommandRecords();
    fixture = createReviewScopeFixture();
    fixture.network.listWorkDrafts.mockResolvedValue({ items: [listed] });
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
      await act(async () =>
        probe().presented.controller.enterInlineReview("document-a", "draft-a"),
      );
      expect(probe().presented.controller.reviewRoomName).toBeNull();
      for (let cancelled = 0; cancelled < 7; cancelled++) {
        await act(async () => {
          await probe().queryClient.cancelQueries({ queryKey: previewKey });
        });
      }
      fixture.network.getDraftPreview.mockResolvedValue(proposal(1, "1", "2"));
      await act(async () => {
        await probe().queryClient.cancelQueries({ queryKey: previewKey });
      });
      await settleReact(() => expect(probe().presented.controller.reviewRoomName).toBe("room-g1"));
      expect(probe().presented.controller.reviewRoomError).toBe(false);
      await act(async () => probe().presented.controller.exitInlineReview());
      fixture.network.getDraftPreview.mockRejectedValue(new Error("offline"));
      await act(async () =>
        probe().presented.controller.enterInlineReview("document-a", "draft-a"),
      );
      await settleReact(() => expect(probe().presented.controller.reviewRoomError).toBe(true));
      fixture.network.getDraftPreview.mockResolvedValue(proposal(1, "1", "2"));
      await act(async () =>
        probe().presented.controller.enterInlineReview("document-a", "draft-a"),
      );
      await settleReact(() => expect(probe().presented.controller.reviewRoomName).toBe("room-g1"));
    });
  });

  it("ignores a held room answer after the account changes", async () => {
    const slow = deferredReviewAnswer<ReturnType<typeof proposal>>();
    fixture.network.getDraftPreview.mockReturnValueOnce(slow.promise);
    await fixture.render(async (probe) => {
      const controller = probe().presented.controller;
      await act(async () => controller.enterInlineReview("document-a", "draft-a"));
      await act(async () => controller.exitInlineReview());
      // Closing the account destroys its query cache and retires its claims.
      await act(async () => {
        probe().queryClient.clear();
        resetDraftCommandRecords();
      });
      await act(async () => slow.resolve(proposal(7, "9")));
      await settleReact(() => expect(probe().presented.controller.inlineReview).toBeNull());
      expect(probe().presented.roomOwner.session).toBeNull();
    });
  });

  it("reconsiders a protected HTTP 404 when writer carry evidence is withdrawn", async () => {
    fixture.dispose();
    let status!: (state: DocumentSessionConnectionState) => void;
    const session = sessions.get("room-g1");
    session.attachTransport(() => ({
      unacknowledgedUpdates: () => null,
      subscribeStatus: (listener) => {
        status = listener;
        return () => {};
      },
      destroy: () => {},
    }));
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
        getBranchRoom: () => session,
      } as unknown as LiveDocumentSessionRegistry,
    });
    fixture.network.listWorkDrafts.mockResolvedValue({ items: [listed] });
    fixture.network.getDraftPreview.mockResolvedValue(proposal(1, "1"));
    await fixture.render(async (probe) => {
      await act(async () =>
        probe().presented.controller.enterInlineReview("document-a", "draft-a"),
      );
      await settleReact(() => expect(probe().presented.roomOwner.session?.roomKey).toBe("room-g1"));
      await act(async () => writerChanges(1));
      fixture.network.getDraftPreview.mockRejectedValue(
        Object.assign(new Error("gone"), { status: 404 }),
      );
      await act(async () =>
        status({
          kind: "reset",
          reason: "branch-generation-stale",
          disposition: "superseded",
        }),
      );
      await settleReact(() =>
        expect(probe().queryClient.getQueryState(previewKey)?.fetchStatus).toBe("idle"),
      );
      expect(probe().queryClient.getQueryData(previewKey)).toEqual({
        status: "gone",
        itemKey: "draft-a",
        branchGeneration: 1,
      });
      expect(probe().queryClient.getQueryData(listKey)).toEqual([listed]);
      expect(probe().presented.controller.inlineReview?.branchGeneration).toBe(1);
      expect(probe().presented.controller.reviewRoomName).toBeNull();
      expect(probe().presented.controller.reviewRoomError).toBe(false);
      const reads = fixture.network.getDraftPreview.mock.calls.length;
      await act(async () => writerChanges(null));
      await settleReact(() => expect(probe().presented.controller.inlineReview).toBeNull());
      expect(fixture.network.getDraftPreview).toHaveBeenCalledTimes(reads);
    });
  });
});

describe("selective completion", () => {
  let fixture: ReturnType<typeof createReviewScopeFixture>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetDraftCommandRecords();
    fixture = createReviewScopeFixture();
    fixture.network.listWorkDrafts.mockResolvedValue({ items: [listed] });
    fixture.network.getDraftPreview.mockResolvedValue(preview);
  });

  afterEach(() => {
    vi.useRealTimers();
    fixture.dispose();
    vi.restoreAllMocks();
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
  async function openReview(p: () => ScopeProbe) {
    await settleReact(() => expect(p().presented.files.length).toBeGreaterThan(0));
    await act(async () => p().presented.controller.enterInlineReview("document-a", "draft-a"));
    await settleReact(() => expect(p().header.view.status).toBe("ready"));
  }
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
      await openReview(p);
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
});

describe("batch lifecycle", () => {
  const draftB = { documentId: "document-b", itemKey: "draft-b" };
  let batchFixture: ReturnType<typeof createReviewScopeFixture>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetDraftCommandRecords();
    useDockDocumentStore.setState(useDockDocumentStore.getInitialState(), true);
    useContextTabsStore.setState({
      byProject: {},
      _workspaceHydrated: false,
    });
    batchFixture = createReviewScopeFixture();
    batchFixture.network.listWorkDrafts.mockResolvedValue({
      items: [
        { ...listed, isNew: true },
        { ...listed, ...draftB, documentName: "Chapter 13" },
      ],
    });
    batchFixture.network.getDraftPreview.mockImplementation(async (_p, _w, _d, id) => ({
      ...previewOf(...(id === "draft-a" ? ["1", "2"] : ["3"])),
      itemKey: id,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    batchFixture.dispose();
    vi.restoreAllMocks();
  });

  it("a missing preview sends no selection and does not stop later files in the batch", async () => {
    const draftC = { documentId: "document-c", itemKey: "draft-c" };
    batchFixture.network.applyDraftChanges.mockResolvedValue(applied(false));
    await batchFixture.render(async (p) => {
      const viewA = await p().mountDraftChanges({
        projectId: "project-a",
        workId: "work-a",
        ...draftA,
      });
      const viewC = await p().mountDraftChanges({
        projectId: "project-a",
        workId: "work-a",
        ...draftC,
      });
      await settleReact(() => expect([viewA().status, viewC().status]).toEqual(["ready", "ready"]));
      await act(async () => {
        const outcomes = await p().chatRunner.applyBatch([
          { draft: draftA, target: { kind: "operations" as const, selection: change("2") } },
          { draft: draftB, target: { kind: "operations" as const, selection: change("3") } },
          { draft: draftC, target: { kind: "operations" as const, selection: change("3") } },
        ]);
        expect(outcomes.map(({ outcome }) => outcome.kind)).toEqual([
          "change-settled",
          "change-refused",
          "change-settled",
        ]);
        expect(outcomes[1].outcome).toEqual({
          kind: "change-refused",
          mode: "apply",
          code: "stale",
        });
      });
      expect(batchFixture.network.applyDraftChanges.mock.calls.map((call) => call[2])).toEqual([
        "document-a",
        "document-c",
      ]);
    });
  });
});

describe("review focus", () => {
  let focusFixture: ReturnType<typeof createReviewScopeFixture>;
  const anchor = { relStart: "", relEnd: "" };
  const hunkOf = (id: string, operationIds: string[]) => ({
    kind: "text" as const,
    hunkId: `h-${id}`,
    operationIds,
    anchor,
    spans: [],
  });
  const inClass = (id: string, closureClassId: string) => ({
    ...operation(id),
    closureClassId,
    admissionToken: closureClassId,
  });

  const threeChanges = {
    ...preview,
    operations: [operation("1"), operation("2"), operation("3")],
    hunks: [hunkOf("1", ["1"]), hunkOf("2", ["2"]), hunkOf("3", ["3"])],
  };
  /** The server joined operation 5 to class 2: the class id moved, operation 2 stayed. */
  const regrouped = {
    ...preview,
    operations: [
      operation("1"),
      inClass("2", "class-2b"),
      inClass("5", "class-2b"),
      operation("3"),
    ],
    hunks: [hunkOf("1", ["1"]), hunkOf("2", ["2", "5"]), hunkOf("3", ["3"])],
  };

  const second = { ...listed, itemKey: "draft-b", documentId: "document-b" };

  async function reviewOpened(probe: () => ScopeProbe) {
    await vi.waitFor(() => expect(focusFixture.network.listWorkDrafts).toHaveBeenCalled());
    await act(async () => probe().presented.controller.enterInlineReview("document-a", "draft-a"));
    await vi.waitFor(() => expect(probe().header.view.status).toBe("ready"));
  }

  const review = { documentId: "document-a", itemKey: "draft-a" };
  const target = (id: string) => ({
    classId: `class-${id}`,
    operationIds: [id],
    anchorOperationId: id,
  });

  beforeEach(() => {
    focusFixture = createReviewScopeFixture();
    resetDraftCommandRecords();
    focusFixture.network.listWorkDrafts.mockResolvedValue({ items: [listed, second] });
    focusFixture.network.getDraftPreview.mockResolvedValue(threeChanges);
  });

  afterEach(() => focusFixture.dispose());

  describe("a change regrouped more than once", () => {
    it("is followed through each regrouping, even when the last shares nothing with the first", async () => {
      await focusFixture.render(async (probe) => {
        await reviewOpened(probe);
        await act(async () => probe().presented.controller.focusReviewChange(review, target("2")));
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
          focusFixture.network.getDraftPreview.mockResolvedValue(next);
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
      let answer!: (response: DraftApplyChangesResponse) => void;
      focusFixture.network.applyDraftChanges.mockReturnValue(
        new Promise((resolve) => (answer = resolve)),
      );
      await focusFixture.render(async (probe) => {
        await reviewOpened(probe);
        const sent = probe().header.view.items[1].change;
        let done!: Promise<void>;
        await act(async () => {
          done = probe().header.view.apply(sent);
        });

        // The writer moves on to another draft before the server answers.
        await act(async () =>
          probe().presented.controller.enterInlineReview("document-b", "draft-b"),
        );
        await vi.waitFor(() =>
          expect(probe().presented.controller.inlineReview?.documentId).toBe("document-b"),
        );

        await act(async () => {
          answer({ status: "stale", draftId: "work-draft-a", itemKey: "draft-a" });
          await done;
        });
        expect(probe().presented.controller.focus).toBeNull();
      });
    });
  });
});
