import { createRequire } from "node:module";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";

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

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis & { close: () => void } };
};

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
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    const rootNode = dom.window.document.getElementById("root");
    if (!rootNode) throw new Error("missing root");
    const root = createRoot(rootNode);

    try {
      await act(async () => {
        root.render(
          <ContextEditorMountHost
            projectId="project-1"
            trackedTabs={[trackedTab]}
            activeTabId="doc-1"
            active={false}
          />,
        );
      });

      expect(setActiveEditorDocumentIdMock).toHaveBeenCalledWith("doc-1");
    } finally {
      await act(async () => root.unmount());
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      dom.window.close();
    }
  });
});
