// @vitest-environment jsdom
/**
 * A review whose room the server reset, with the real branch-room pool and real
 * sessions behind it: the mounted editor and the review's refresh each own the
 * room. Only the HTTP and the socket are faked. The stale editor must leave the
 * old generation's room to retire while the other owner still holds it, and the
 * review must then bind the new generation's room.
 */

import { branchRoomName } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import { BranchRoomPool } from "@/core/editor/branch-room-pool";
import {
  DocumentSession,
  type DocumentSessionConnectionState,
} from "@/core/editor/document-session";
import { DocumentSessionTeardownOwner } from "@/core/editor/document-session-teardown-owner";
import {
  DraftReviewBoundary,
  useDraftReview,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import { draftA, listed, previewOf, work } from "@/test-support/draft-review-scope";
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
  useLiveDocumentSessionRegistry: () => poolRegistry,
  useAccountResourceProjection: () => ({ snapshot: null, records: [], error: null }),
}));
vi.mock("@/features/links", async () => ({
  useLinkFollower: (await import("@/features/links/use-link-follower")).useLinkFollower,
  useLinkableDocuments: () => ({ documents: [], revision: "", complete: false }),
}));
vi.mock("./references/useReferenceBrowserCatalog", () => ({
  useReferenceBrowserCatalog: () => null,
}));
vi.mock("./useInlineReviewSync", () => ({ useInlineReviewSync: () => {} }));
vi.mock("./useInlineReviewFocus", () => ({ useInlineReviewFocus: () => {} }));
vi.mock("./SyncStatus", () => ({ SyncStatus: () => null }));
vi.mock("./chrome/chrome-surfaces", () => ({ EDITOR_CHROME_SURFACES: [] }));

const { EditorView } = await import("./EditorView");

const documentId = "document-a";
const transportStatus = new Map<string, (state: DocumentSessionConnectionState) => void>();
const pool = new BranchRoomPool({
  teardownGraceMs: 1,
  teardownOwner: new DocumentSessionTeardownOwner(() => new Error("room is retiring")),
  openSession: (roomKey) =>
    new DocumentSession({
      roomKey,
      persistence: { kind: "none" },
      transportFactory: () => ({
        synced: true,
        whenSynced: Promise.resolve(),
        subscribeStatus: (listener) => {
          transportStatus.set(roomKey, listener);
          listener({ kind: "connected" });
          return () => {};
        },
        subscribeAccess: (listener) => {
          listener("edit");
          return () => {};
        },
        subscribeServerAcknowledgement: (listener) => {
          listener(false);
          return () => {};
        },
        destroy: () => {},
      }),
    }),
});
const poolRegistry = {
  retainBranchRooms: (owner: string, rooms: Iterable<string>) => pool.retain(owner, rooms),
  releaseBranchRooms: (owner: string) => pool.release(owner),
  getBranchRoom: (room: string) => pool.get(room),
  rebuildBranchRoom: (room: string) => pool.rebuild(room),
};

let review: ReturnType<typeof useDraftReview> | null = null;

function Host() {
  const value = useDraftReview();
  review = value;
  const { inlineReview, reviewRoomName, inlineReviewModelAvailable } = value.controller;
  useEffect(() => {
    if (inlineReview && reviewRoomName) {
      inlineReviewModelAvailable("preview-1", inlineReview.documentId, inlineReview.draftId);
    }
  }, [inlineReview, reviewRoomName, inlineReviewModelAvailable]);
  return (
    <EditorView
      documentId={documentId}
      projectId="project-a"
      session={sessionFor(documentId)}
      reviewDraftId={inlineReview?.draftId}
      reviewRoomName={reviewRoomName ?? undefined}
      onReviewSessionUnavailable={value.controller.exitInlineReview}
      onReviewRoomStale={value.controller.reviewRoomStale}
    />
  );
}

function Scope() {
  const value = useDraftReviewScopeValue({ projectId: "project-a", work });
  return (
    <DraftReviewBoundary value={value}>
      <Host />
    </DraftReviewBoundary>
  );
}

const surfaces = () =>
  [...document.querySelectorAll<HTMLElement>("[data-editor-surface]")]
    .filter((wrapper) => !wrapper.classList.contains("hidden"))
    .map((wrapper) => wrapper.dataset.editorSurface);

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftCommandRecords();
  review = null;
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
});

afterEach(() => pool.invalidate());

describe("a reset review room with its two owners", () => {
  it.each([
    "branch-generation-stale",
    "branch-stale-doc",
  ] as const)("binds the next generation's room after %s", async (reason) => {
    const oldRoom = branchRoomName(`stale-room-${reason}`, 1);
    const newRoom = branchRoomName(`stale-room-${reason}`, 2);
    mocks.getDraftPreview.mockResolvedValue({ ...previewOf("2"), reviewRoomName: oldRoom });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withReactRoot(
      <QueryClientProvider client={queryClient}>
        <Scope />
      </QueryClientProvider>,
      async () => {
        await act(async () => review?.controller.enterInlineReview(documentId, draftA.draftId));
        await vi.waitFor(() => expect(surfaces()).toEqual(["review"]));
        const old = pool.peek(oldRoom);
        expect(old).toBeDefined();

        mocks.getDraftPreview.mockResolvedValue({
          ...previewOf("5"),
          draftGeneration: 2,
          reviewRoomName: newRoom,
        });
        mocks.listWorkDrafts.mockResolvedValue({ drafts: [{ ...listed, draftGeneration: 2 }] });
        // The reset arrives inside a React flush, so the editor's and the refresh's cleanups
        // run while the old session is still retiring.
        await act(async () => transportStatus.get(oldRoom)?.({ kind: "reset", reason }));

        await vi.waitFor(() => expect(review?.controller.reviewRoomName).toBe(newRoom));
        await vi.waitFor(() => expect(surfaces()).toEqual(["review"]));
        expect(review?.controller.inlineReview?.draftGeneration).toBe(2);
        expect(pool.peek(newRoom)).toBeDefined();
        await vi.waitFor(() => expect(old?.getSnapshot().status).toBe("destroyed"));
        expect(pool.peek(oldRoom)).toBeUndefined();
      },
    );
  });
});
