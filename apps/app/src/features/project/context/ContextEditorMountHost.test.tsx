import { describe, expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";

const setActiveEditorDocumentIdMock = vi.fn();

vi.mock("@/features/chat/DraftReviewProvider", () => ({
  useDraftReview: () => ({
    controller: { inlineReview: null },
    reviewRoomNameForDraft: () => null,
    setActiveEditorDocumentId: setActiveEditorDocumentIdMock,
  }),
}));
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({
    retain: vi.fn(),
    release: vi.fn(),
    get: vi.fn(),
  }),
}));
vi.mock("@/features/editor/EditorView", () => ({
  EditorView: () => null,
}));

const { ContextEditorMountHost } = await import("./ContextEditorMountHost");

const trackedTab: ContextTab = {
  documentId: "doc-1",
  scheme: "manuscript",
  path: "/chapter-1.md",
  name: "chapter-1.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

describe("ContextEditorMountHost active editor wiring", () => {
  it("reports the active tracked tab id even when the context route is inactive", async () => {
    setActiveEditorDocumentIdMock.mockClear();
    await withReactRoot(
      <ContextEditorMountHost
        projectId="project-1"
        trackedTabs={[trackedTab]}
        activeTabId="doc-1"
        active={false}
      />,
      () => {
        expect(setActiveEditorDocumentIdMock).toHaveBeenCalledWith("doc-1");
      },
    );
  });
});
