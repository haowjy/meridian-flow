// @vitest-environment jsdom
/**
 * A review learns that the draft changed under it, from the real provider
 * outward: controller, query cache and `useInlineReviewSync` are real; the
 * network and the document sessions are the only fakes. A second tab's
 * per-change Apply writes the live document this tab holds underneath its
 * review; the review must re-read its preview promptly, whatever else re-renders
 * the editor while the read is waiting. One edit is one read: the review owner
 * (`useReviewRefresh`) is the only subscriber.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { act, useEffect, useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  DraftReviewBoundary,
  useDraftReview,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import { listed, previewOf, work } from "@/test-support/draft-review-scope";
import { registry, sessionFor } from "@/test-support/editor-session-fakes";
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
  useLiveDocumentSessionRegistry: () => registry,
  useAccountResourceProjection: () => ({ snapshot: null, records: [], error: null }),
}));
vi.mock("@/features/links", async () => ({
  useLinkFollower: (await import("@/features/links/use-link-follower")).useLinkFollower,
  useLinkableDocuments: () => ({ documents: [], revision: "", complete: false }),
}));
vi.mock("./references/useReferenceBrowserCatalog", () => ({
  useReferenceBrowserCatalog: () => null,
}));
vi.mock("./useInlineReviewFocus", () => ({ useInlineReviewFocus: () => {} }));
vi.mock("./SyncStatus", () => ({ SyncStatus: () => null }));
vi.mock("./chrome/chrome-surfaces", () => ({ EDITOR_CHROME_SURFACES: [] }));

const { EditorView } = await import("./EditorView");

const documentId = "document-a";
let review: ReturnType<typeof useDraftReview> | null = null;
let rerenderHost: () => void = () => {};

function Host() {
  const value = useDraftReview();
  const [, setTick] = useState(0);
  // The hosts tell the review which live document the editor holds (`ActiveEditorProjection`);
  // the review owner watches it for changes made elsewhere.
  const owner = useRef({});
  const { setActiveEditorDocumentId } = value;
  useEffect(() => {
    setActiveEditorDocumentId(documentId, sessionFor(documentId), true, owner.current);
    return () => setActiveEditorDocumentId(null, null, false, owner.current);
  }, [setActiveEditorDocumentId]);
  rerenderHost = () => setTick((tick) => tick + 1);
  review = value;
  return (
    <EditorView
      documentId={documentId}
      projectId="project-a"
      session={sessionFor(documentId)}
      reviewWorkId={work.id}
      reviewDraftId={value.controller.inlineReview?.draftId}
      reviewRoomName={value.controller.reviewRoomName ?? undefined}
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

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftCommandRecords();
  review = null;
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  mocks.getDraftPreview.mockResolvedValue(previewOf("1", "2"));
});

describe("a review whose draft changed under it", () => {
  it("re-reads the preview after another tab changes live, even when the editor re-renders meanwhile", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withReactRoot(
      <QueryClientProvider client={queryClient}>
        <Scope />
      </QueryClientProvider>,
      async () => {
        await act(async () => review?.controller.enterInlineReview(documentId, "draft-a"));
        await vi.waitFor(() =>
          expect(review?.controller.inlineReview?.previewIdentity).toBeDefined(),
        );
        // Let the review settle: no read is waiting.
        await new Promise((resolve) => setTimeout(resolve, 700));
        const readsBefore = mocks.getDraftPreview.mock.calls.length;

        // Another tab's per-change Apply lands in the live document this tab holds.
        const live = sessionFor(documentId).document;
        mocks.getDraftPreview.mockResolvedValue(previewOf("2"));
        await act(async () => {
          live.getMap("remote").set("applied", "1");
        });
        // Anything that re-renders the editor inside the debounce window.
        await act(async () => rerenderHost());
        await act(async () => rerenderHost());

        await vi.waitFor(
          () => expect(mocks.getDraftPreview.mock.calls.length).toBeGreaterThan(readsBefore),
          { timeout: 3000 },
        );
      },
      { drainMacrotask: true },
    );
  });

  it("reads the preview once for one local edit in the review editor, not once per subscriber", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await withReactRoot(
      <QueryClientProvider client={queryClient}>
        <Scope />
      </QueryClientProvider>,
      async () => {
        await act(async () => review?.controller.enterInlineReview(documentId, "draft-a"));
        await vi.waitFor(() =>
          expect(review?.controller.inlineReview?.previewIdentity).toBeDefined(),
        );
        await new Promise((resolve) => setTimeout(resolve, 700));
        const readsBefore = mocks.getDraftPreview.mock.calls.length;

        // The writer types in the review editor.
        const editors = [
          ...document.querySelectorAll<HTMLElement & { editor?: Editor }>(".ProseMirror"),
        ];
        const reviewEditor = editors.find((dom) => !dom.closest(".hidden"))?.editor;
        if (!reviewEditor) throw new Error("no visible editor");
        await act(async () => {
          reviewEditor.commands.insertContent("a few words");
        });
        // Long enough for every debounce a subscriber could have.
        await new Promise((resolve) => setTimeout(resolve, 1500));

        expect(mocks.getDraftPreview.mock.calls.length - readsBefore).toBe(1);
      },
      { drainMacrotask: true },
    );
  });
});
