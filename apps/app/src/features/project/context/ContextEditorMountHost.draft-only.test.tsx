// @vitest-environment jsdom
/** A draft-only document under review is hosted by its branch room alone; the live room opens once Apply promotes it. */

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
}));
vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({
    controller: {
      workId: "work-a",
      inlineReview: { documentId: "document-a", draftId: "draft-a" },
      reviewRoomError: false,
    },
    reviewRoomNameForDraft: () => "review-room-a",
    setActiveEditorDocumentId: vi.fn(),
  }),
}));
vi.mock("@/features/editor/EditorView", () => ({
  EditorView: (props: { session?: unknown; reviewRoomName?: string | null }) => (
    <div
      data-editor
      data-live-session={String(props.session !== undefined)}
      data-review-room={props.reviewRoomName ?? ""}
    />
  ),
}));

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

    function Harness() {
      const [promoted, setPromoted] = useState(false);
      promote = () => setPromoted(true);
      const hostedTab = (
        promoted
          ? tab
          : { ...tab, draftOnly: true, reviewWorkId: "work-a", reviewDraftId: "draft-a" }
      ) as ComponentProps<typeof ContextEditorMountHost>["trackedTabs"][number];
      return (
        <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
          <ContextEditorMountHost
            projectId="project-a"
            workId="work-a"
            trackedTabs={[hostedTab]}
            activeTabId="document-a"
            active
          />
        </ProjectDocumentLiveOpenerContext.Provider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      await act(async () => undefined);
      const editor = document.querySelector("[data-editor]");
      expect(editor?.getAttribute("data-review-room")).toBe("review-room-a");
      expect(editor?.getAttribute("data-live-session")).toBe("false");
      expect(opener.open).not.toHaveBeenCalled();
      expect(resourceReplica.openDocument).not.toHaveBeenCalled();

      await act(async () => promote());
      await act(async () => undefined);
      expect(opener.open).toHaveBeenCalledOnce();
    });
  });
});
