// @vitest-environment jsdom
/** Real editor, controller, sessions and handoff: only HTTP and the held wire are fake. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { act, useEffect, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { useWorkDrafts } from "@/client/query/useWorkDrafts";
import {
  DraftReviewBoundary,
  useDraftReview,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import { listed, previewOf, work } from "@/test-support/draft-review-scope";
import { sessionFor } from "@/test-support/editor-session-fakes";
import { withReactRoot } from "@/test-support/react-dom-harness";

const mocks = vi.hoisted(() => ({
  listWorkDrafts: vi.fn(),
  getDraftPreview: vi.fn(),
  applyDraftChanges: vi.fn(),
  discardDraft: vi.fn(),
}));

vi.mock("@/client/api/drafts-api", () => mocks);
vi.mock("@/client/query/useContextCatalog", () => ({
  contextCatalogScope: () => ({ kind: "project", projectId: "project-a" }),
  useContextCatalogView: () => ({
    catalog: null,
    isError: false,
    isFetching: false,
    refetch: () => {},
  }),
  projectCatalogView: () => ({ findDocument: () => null }),
}));
vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: [], isError: false, isFetching: false }),
}));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ noWork: { id: "no-work", slug: null, archivedAt: null }, works: [] }),
}));
vi.mock("@/features/change-trail/trail-detail-query", () => ({
  usePrefetchTrailDetails: () => {},
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({ promoteAppliedDraft: vi.fn(), discardDraft: vi.fn() }),
  useOptionalAccountResourceReplica: () => null,
  useLiveDocumentSessionRegistry: () => realRegistry,
  useAccountResourceProjection: () => ({ snapshot: null, records: [], error: null }),
}));
vi.mock("@/features/links", async () => ({
  useLinkFollower: (await import("@/features/links/use-link-follower")).useLinkFollower,
  useLinkableDocuments: () => ({ documents: [], revision: "", complete: false }),
}));
vi.mock("@/features/editor/references/useReferenceBrowserCatalog", () => ({
  useReferenceBrowserCatalog: () => null,
}));
vi.mock("@/features/editor/useInlineReviewSync", () => ({ useInlineReviewSync: () => {} }));
vi.mock("@/features/editor/useInlineReviewFocus", () => ({ useInlineReviewFocus: () => {} }));
vi.mock("@/features/editor/SyncStatus", () => ({ SyncStatus: () => null }));
vi.mock("@/features/editor/chrome/chrome-surfaces", () => ({ EDITOR_CHROME_SURFACES: [] }));

const { EditorView } = await import("@/features/editor/EditorView");

const documentId = "document-a";
let review: ReturnType<typeof useDraftReview> | null = null;

/** The editor host's part: hand `EditorView` the review the controller has open, and report the marks. */
function Host() {
  const value = useDraftReview();
  review = value;
  const { inlineReview, reviewRoomName, inlineReviewModelAvailable } = value.controller;
  useEffect(() => {
    // `useInlineReviewSync` reports this once the review's marks have arrived.
    if (inlineReview && reviewRoomName) {
      inlineReviewModelAvailable("preview-1", inlineReview.documentId, inlineReview.draftId);
    }
  }, [inlineReview, reviewRoomName, inlineReviewModelAvailable]);
  return (
    <EditorView
      documentId={documentId}
      projectId="project-a"
      session={sessionFor(documentId)}
      reviewWorkId="work-a"
      reviewDraftId={inlineReview?.draftId}
      reviewRoomName={reviewRoomName ?? undefined}
      onReviewSessionUnavailable={value.controller.exitInlineReview}
    />
  );
}

let unmountReview!: () => void;
function WorkList() {
  const { drafts } = useWorkDrafts("project-a", "work-a");
  return <output data-work-list>{drafts?.map((draft) => draft.draftId).join(",")}</output>;
}

function Scope() {
  const [mounted, setMounted] = useState(true);
  unmountReview = () => setMounted(false);
  const value = useDraftReviewScopeValue({ projectId: "project-a", work });
  return (
    <DraftReviewBoundary value={value}>
      <WorkList />
      {mounted && <Host />}
    </DraftReviewBoundary>
  );
}

const surfaces = () =>
  [...document.querySelectorAll<HTMLElement>("[data-editor-surface]")]
    .filter((wrapper) => !wrapper.classList.contains("hidden"))
    .map((wrapper) => wrapper.dataset.editorSurface);

function renderEditor(run: () => Promise<void>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  testQueryClient = queryClient;
  return withReactRoot(
    <QueryClientProvider client={queryClient}>
      <Scope />
    </QueryClientProvider>,
    run,
  );
}

async function reviewOpened() {
  await act(async () => review?.controller.enterInlineReview(documentId, "draft-a"));
  await vi.waitFor(() => expect(surfaces()).toEqual(["review"]));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftCommandRecords();
  review = null;
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  mocks.getDraftPreview.mockResolvedValue(previewOf("2"));
});

import { branchRoomName } from "@meridian/contracts/protocol";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { branchHandoffHarness } from "@/test-support/branch-handoff-harness";

let testQueryClient: QueryClient;
let runtime: ReturnType<typeof branchHandoffHarness>;
const realRegistry = {
  retainBranchRooms: (owner: string, rooms: Parameters<typeof runtime.pool.retain>[1]) =>
    runtime.pool.retain(owner, rooms),
  releaseBranchRooms: (owner: string) => runtime.pool.release(owner),
  getBranchRoom: (room: string) => {
    const session = runtime.pool.get(room);
    runtime.wire(room).sync();
    return session;
  },
  rebuildBranchRoom: async (room: string) => {
    const session = await runtime.pool.rebuild(room);
    runtime.wire(room).sync();
    return session;
  },
};
const branchEditor = (): Editor => {
  const dom = document.querySelector<HTMLElement & { editor?: Editor }>(
    "[data-editor-surface=review] .ProseMirror",
  );
  if (!dom?.editor) throw new Error("no review editor");
  return dom.editor;
};
it.each([
  "branch-generation-stale",
  "branch-stale-doc",
  "list",
  "successor typing",
  "remote whole Discard",
])("writer edit survives reentry after %s", async (reason) => {
  vi.useFakeTimers();
  runtime = branchHandoffHarness();
  const oldRoom = branchRoomName("writer-loss", 1);
  const newRoom = reason === "branch-stale-doc" ? oldRoom : branchRoomName("writer-loss", 2);
  mocks.getDraftPreview.mockResolvedValue({ ...previewOf("2"), reviewRoomName: oldRoom });
  try {
    await renderEditor(async () => {
      await reviewOpened();
      await act(async () => {
        branchEditor().commands.insertContent("UNACKNOWLEDGED WRITER WORDS");
      });
      const old = runtime.pool.peek(oldRoom);
      if (!old) throw new Error("No source review session");
      expect(old.getSnapshot().serverHasLocalChanges).toBe(false);
      let locate!: (room: string) => void;

      mocks.getDraftPreview.mockResolvedValue({
        ...previewOf(...(reason === "remote whole Discard" ? [] : ["5"])),
        draftGeneration: 2,
        reviewRoomName: newRoom,
      });
      mocks.listWorkDrafts.mockResolvedValue({
        drafts: reason === "remote whole Discard" ? [] : [{ ...listed, draftGeneration: 2 }],
      });
      if (reason === "remote whole Discard") {
        await act(async () => {
          await testQueryClient.invalidateQueries({
            queryKey: projectQueryKeys.workDrafts("project-a", "work-a"),
          });
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(review?.controller.inlineReview?.draftId).toBe("draft-a");
        expect(document.querySelector("[data-work-list]")?.textContent).toBe("");
      }
      await act(async () => {
        if (reason === "list" || reason === "successor typing") {
          await testQueryClient.invalidateQueries({
            queryKey: projectQueryKeys.workDrafts("project-a", "work-a"),
          });
          if (reason === "list") {
            review?.controller.exitInlineReview();
            unmountReview();
            mocks.listWorkDrafts.mockResolvedValue({ drafts: [] });
            mocks.getDraftPreview.mockResolvedValue({
              ...previewOf(),
              draftGeneration: 2,
              reviewRoomName: newRoom,
            });
            await testQueryClient.invalidateQueries({
              queryKey: projectQueryKeys.workDrafts("project-a", "work-a"),
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(document.querySelector("[data-work-list]")?.textContent).toBe("");
            expect(surfaces()).toEqual([]);
          }
          await vi.advanceTimersByTimeAsync(10);
          expect(runtime.pool.peek(oldRoom)).toBe(old);
        }
        if (reason === "successor typing")
          mocks.getDraftPreview.mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                locate = (room) =>
                  resolve({ ...previewOf("5"), draftGeneration: 2, reviewRoomName: room });
              }),
          );
        runtime.wire(oldRoom).emit({
          kind: "reset",
          reason: reason === "branch-stale-doc" ? "branch-stale-doc" : "branch-generation-stale",
          disposition: reason === "branch-stale-doc" ? "rebuild" : "superseded",
        });
      });
      if (reason === "remote whole Discard") {
        await act(async () => {
          await testQueryClient.invalidateQueries({
            queryKey: projectQueryKeys.workDrafts("project-a", "work-a"),
          });
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(review?.controller.inlineReview?.draftId).toBe("draft-a");
        expect(document.querySelector("[data-work-list]")?.textContent).toBe("");
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      if (reason === "successor typing") {
        await act(async () => {
          branchEditor().commands.insertContent("SUCCESSOR WORDS");
          locate(newRoom);
        });
      }
      await act(async () => {
        runtime.wire(newRoom).sync();
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(surfaces()).toEqual(reason === "list" ? [] : ["review"]);
      expect(old.document.isDestroyed).toBe(true);
      if (reason !== "list")
        expect(branchEditor().getText()).toContain("UNACKNOWLEDGED WRITER WORDS");
      if (reason === "successor typing")
        expect(branchEditor().getText()).toContain("SUCCESSOR WORDS");
      await act(async () => {
        if (reason === "list") {
          expect(runtime.wire(newRoom).sent.length).toBeGreaterThan(0);
          expect(document.querySelector("[data-work-list]")?.textContent).toBe("");
          mocks.listWorkDrafts.mockResolvedValue({ drafts: [{ ...listed, draftGeneration: 2 }] });
        }
        if (reason === "remote whole Discard") {
          mocks.listWorkDrafts.mockResolvedValue({ drafts: [{ ...listed, draftGeneration: 2 }] });
          mocks.getDraftPreview.mockResolvedValue({
            ...previewOf("writer"),
            operations: [{ ...previewOf("writer").operations[0], kind: "writer" }],
            draftGeneration: 2,
            reviewRoomName: newRoom,
          });
        }
        runtime.wire(newRoom).ack();
        await vi.advanceTimersByTimeAsync(10);
      });
      if (reason === "remote whole Discard") {
        expect(surfaces()).toEqual(["review"]);
        expect(review?.controller.inlineReview?.draftGeneration).toBe(2);
        expect(branchEditor().getText()).toContain("UNACKNOWLEDGED WRITER WORDS");
        expect(document.querySelector("[data-work-list]")?.textContent).toBe("draft-a");
      }
      if (reason === "list") {
        expect(document.querySelector("[data-work-list]")?.textContent).toBe("draft-a");
        expect(runtime.pool.peek(newRoom)).toBeUndefined();
      }
    });
  } finally {
    await runtime.dispose();
    testQueryClient.clear();
    vi.useRealTimers();
  }
});
