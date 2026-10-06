// @vitest-environment jsdom
/** A draft-only document under review is hosted by its branch room alone; a live document keeps painting while its review room resolves. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DocumentSession } from "@/core/editor/document-session";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextEditorMountHost } from "./ContextEditorMountHost";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";

const resourceReplica = vi.hoisted(() => ({
  keyForDocument: vi.fn(async () => null),
  openDocument: vi.fn(),
  captureServerSession: vi.fn(async () => undefined),
}));

vi.mock("./account-feature-context", () => ({
  useAccountResourceReplica: () => resourceReplica,
  useAccountResourceProjection: () => ({ records: [], snapshot: null, error: null }),
  useLiveDocumentSessionRegistry: () => ({
    whenRefusedRoomDropped: () => null,
    observeBranchRoom: () => () => undefined,
  }),
}));
const review = vi.hoisted(() => ({
  reviewing: false,
  room: "review-room-a" as string | null,
  publish: vi.fn(),
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({
    controller: {
      workId: "work-a",
      inlineReview: review.reviewing ? { documentId: "document-a", draftId: "draft-a" } : null,
      reviewRoomError: false,
    },
    reviewRoomNameForDraft: () => review.room,
    setActiveEditorDocumentId: review.publish,
  }),
}));
vi.mock("@/features/editor/EditorView", () => ({
  EditorView: (props: {
    session?: unknown;
    reviewDraftId?: string | null;
    reviewRoomName?: string | null;
    onReviewSessionUnavailable?: () => void;
  }) => (
    <div
      data-editor
      data-leaves-review-when-unavailable={String(props.onReviewSessionUnavailable !== undefined)}
      data-live-session={String(props.session !== undefined)}
      data-review-draft={props.reviewDraftId ?? ""}
      data-review-room={props.reviewRoomName ?? ""}
    />
  ),
}));

const queryClient = new QueryClient();

const liveSession = {
  getSnapshot: () => ({ status: "synced", schemaFence: null }),
  subscribe: () => () => undefined,
  suspendPresence: () => undefined,
  resumePresence: () => undefined,
} as unknown as DocumentSession;

const tab = {
  kind: "tracked",
  documentId: "document-a",
  scheme: "manuscript",
  path: "/chapter.md",
  name: "chapter.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
} as const;

describe("ContextEditorMountHost draft-only review", () => {
  review.reviewing = false;
  it("opens no live room while reviewing, then opens the ordinary one once promoted", async () => {
    const opener = {
      open: vi.fn(async () => ({
        kind: "opened",
        admission: {
          projectId: "project-a",
          documentId: "document-a",
          generation: "1",
          bind: async () => ({
            projectId: "project-a",
            documentId: "document-a",
            generation: "1",
            session: liveSession,
            release: vi.fn(),
          }),
        },
      })),
    };
    let promote!: () => void;
    let startReview!: () => void;

    function Harness() {
      const [promoted, setPromoted] = useState(false);
      const [, setReviewing] = useState(false);
      promote = () => setPromoted(true);
      startReview = () => {
        review.reviewing = true;
        setReviewing(true);
      };
      const hostedTab = (
        promoted
          ? tab
          : { ...tab, draftOnly: true, reviewWorkId: "work-a", reviewDraftId: "draft-a" }
      ) as ComponentProps<typeof ContextEditorMountHost>["trackedTabs"][number];
      return (
        <QueryClientProvider client={queryClient}>
          <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
            <ContextEditorMountHost
              projectId="project-a"
              workId="work-a"
              trackedTabs={[hostedTab]}
              activeTabId="document-a"
              active
            />
          </ProjectDocumentLiveOpenerContext.Provider>
        </QueryClientProvider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      await act(async () => undefined);
      // The review handoff claims review once the document is published as the
      // active editor, which needs no live session.
      expect(review.publish).toHaveBeenCalledWith("document-a", null, false, expect.anything());
      await act(async () => startReview());
      const editor = document.querySelector("[data-editor]");
      expect(editor?.getAttribute("data-review-room")).toBe("review-room-a");
      expect(editor?.getAttribute("data-live-session")).toBe("false");
      // Leaving review would strand a draft-only tab on an empty editor.
      expect(editor?.getAttribute("data-leaves-review-when-unavailable")).toBe("false");
      expect(opener.open).not.toHaveBeenCalled();
      expect(resourceReplica.openDocument).not.toHaveBeenCalled();

      await act(async () => promote());
      await act(async () => undefined);
      expect(opener.open).toHaveBeenCalledOnce();
    });
  });

  it("keeps the live editor on screen, with the review intent, while the review room is still resolving", async () => {
    review.reviewing = true;
    review.room = null;
    const opener = {
      open: vi.fn(async () => ({
        kind: "opened",
        admission: {
          projectId: "project-a",
          documentId: "document-a",
          generation: "1",
          bind: async () => ({
            projectId: "project-a",
            documentId: "document-a",
            generation: "1",
            session: liveSession,
            release: vi.fn(),
          }),
        },
      })),
    };
    await withReactRoot(
      <QueryClientProvider client={queryClient}>
        <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
          <ContextEditorMountHost
            projectId="project-a"
            workId="work-a"
            trackedTabs={[tab]}
            activeTabId="document-a"
            active
          />
        </ProjectDocumentLiveOpenerContext.Provider>
      </QueryClientProvider>,
      async () => {
        await act(async () => undefined);
        const editor = document.querySelector("[data-editor]");
        expect(editor?.getAttribute("data-live-session")).toBe("true");
        expect(editor?.getAttribute("data-review-room")).toBe("");
        // The click's intent reaches the editor, which holds the live one read-only.
        expect(editor?.getAttribute("data-review-draft")).toBe("draft-a");
      },
    );
    review.reviewing = false;
    review.room = "review-room-a";
  });
});
