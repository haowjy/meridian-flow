// @vitest-environment jsdom
/**
 * The editor under the last change's command, from the real provider outward:
 * controller, mutations and query cache are real; the network and the document
 * sessions are the only fakes. Pending holds the finished text inert (a last
 * Discard) or keeps the review (a last Apply); only the server's `draftClosed`
 * answer makes the live editor editable; an answer that did not close the draft
 * brings the review back.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { act, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDraftCommandRecords } from "@/client/query/draft-command-record";
import {
  DraftReviewBoundary,
  useDraftReview,
  useDraftReviewScopeValue,
} from "@/features/chat/DraftReviewProvider";
import {
  applied,
  change,
  discarded,
  listed,
  previewOf,
  work,
} from "@/test-support/draft-review-scope";
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
vi.mock("./useInlineReviewSync", () => ({ useInlineReviewSync: () => {} }));
vi.mock("./useInlineReviewFocus", () => ({ useInlineReviewFocus: () => {} }));
vi.mock("./SyncStatus", () => ({ SyncStatus: () => null }));
vi.mock("./chrome/chrome-surfaces", () => ({ EDITOR_CHROME_SURFACES: [] }));

const { EditorView } = await import("./EditorView");

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
      reviewDraftId={inlineReview?.draftId}
      reviewRoomName={reviewRoomName ?? undefined}
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

/** The warm live editor, whether or not it is the one showing. */
const liveEditor = (): Editor => {
  const dom = document
    .querySelector<HTMLElement>("[data-editor-surface=live]")
    ?.querySelector<HTMLElement & { editor?: Editor }>(".ProseMirror");
  if (!dom?.editor) throw new Error("no live editor");
  return dom.editor;
};
const liveEditable = () => liveEditor().view.dom.getAttribute("contenteditable");

function renderEditor(run: () => Promise<void>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  // The review's own editor has the text: the live one waits underneath, read-only.
  expect(liveEditable()).toBe("false");
}

function held(mock: typeof mocks.discardDraft) {
  let answer!: (response: unknown) => void;
  mock.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  return (response: unknown) => answer(response);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDraftCommandRecords();
  review = null;
  mocks.listWorkDrafts.mockResolvedValue({ drafts: [listed] });
  mocks.getDraftPreview.mockResolvedValue(previewOf("2"));
});

describe("a last Discard", () => {
  it("shows the finished text at the click, inert, until the server says it closed the draft", async () => {
    const answer = held(mocks.discardDraft);
    await renderEditor(async () => {
      await reviewOpened();
      let done: Promise<unknown> | undefined;
      await act(async () => {
        done = review?.controller.discardChange(change("2"));
      });
      // Pending: the live text stands in for the review, but nothing can be typed into it yet.
      expect(surfaces()).toEqual(["live"]);
      expect(liveEditable()).toBe("false");

      await act(async () => {
        answer(discarded(true));
        await done;
      });
      // Confirmed closed: the same warm editor, editable.
      expect(surfaces()).toEqual(["live"]);
      expect(liveEditable()).toBe("true");
    });
  });

  it("brings the review back, not an editable live editor, when another change kept the draft open", async () => {
    const answer = held(mocks.discardDraft);
    await renderEditor(async () => {
      await reviewOpened();
      let done: Promise<unknown> | undefined;
      await act(async () => {
        done = review?.controller.discardChange(change("2"));
      });
      expect(surfaces()).toEqual(["live"]);

      mocks.getDraftPreview.mockResolvedValue(previewOf("3"));
      await act(async () => {
        answer(discarded(false));
        await done;
      });
      await vi.waitFor(() => expect(surfaces()).toEqual(["review"]));
      // The writer is in the draft's review, and live is read-only beneath it.
      expect(liveEditable()).toBe("false");
      expect(review?.controller.inlineReview?.completion).toBeUndefined();
    });
  });

  it("brings the review back when the Discard does not land", async () => {
    mocks.discardDraft.mockRejectedValue(new Error("offline"));
    await renderEditor(async () => {
      await reviewOpened();
      await act(async () => {
        await review?.controller.discardChange(change("2"));
      });
      await vi.waitFor(() => expect(surfaces()).toEqual(["review"]));
      expect(liveEditable()).toBe("false");
    });
  });
});

describe("a last Apply", () => {
  it("keeps the review while pending (live has no change in it yet), then reveals editable live when closed", async () => {
    const answer = held(mocks.applyDraftChanges);
    await renderEditor(async () => {
      await reviewOpened();
      let done: Promise<unknown> | undefined;
      await act(async () => {
        done = review?.controller.applyChange(change("2"));
      });
      expect(review?.controller.inlineReview?.completion).toMatchObject({ phase: "pending" });
      expect(surfaces()).toEqual(["review"]);
      expect(liveEditable()).toBe("false");

      await act(async () => {
        answer(applied(true));
        await done;
      });
      expect(surfaces()).toEqual(["live"]);
      expect(liveEditable()).toBe("true");
    });
  });

  it("stays in the review when the server kept the draft open", async () => {
    mocks.applyDraftChanges.mockResolvedValue(applied(false));
    await renderEditor(async () => {
      await reviewOpened();
      mocks.getDraftPreview.mockResolvedValue(previewOf("3"));
      await act(async () => {
        await review?.controller.applyChange(change("2"));
      });
      expect(surfaces()).toEqual(["review"]);
      expect(liveEditable()).toBe("false");
    });
  });
});
