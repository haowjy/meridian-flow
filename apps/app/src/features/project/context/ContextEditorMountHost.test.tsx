import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";

const setActiveEditorDocumentIdMock = vi.fn();

vi.mock("@/features/chat/DraftReviewProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/chat/DraftReviewProvider")>();
  return {
    ...actual,
    useDraftReview: () => ({
      controller: { inlineReview: null, isDisposing: false },
      reviewRoomNameForDraft: () => null,
      setActiveEditorDocumentId: setActiveEditorDocumentIdMock,
    }),
  };
});
vi.mock("@/core/editor/document-session-registry", () => ({
  getDocumentSessionRegistry: () => ({
    retain: vi.fn(),
    release: vi.fn(),
    get: vi.fn(() => ({ suspendPresence: vi.fn(), resumePresence: vi.fn() })),
  }),
}));
vi.mock("@/features/editor/EditorView", () => ({
  EditorView: () => null,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

const { ContextEditorMountHost } = await import("./ContextEditorMountHost");

const trackedTab: Extract<ContextTab, { editable: true }> = {
  kind: "tracked",
  documentId: "doc-1",
  scheme: "manuscript",
  path: "/chapter-1.md",
  name: "chapter-1.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

beforeEach(() => {
  setActiveEditorDocumentIdMock.mockClear();
});

describe("ContextEditorMountHost active editor wiring", () => {
  it("reports the active tracked tab id even when the context route is inactive", async () => {
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
