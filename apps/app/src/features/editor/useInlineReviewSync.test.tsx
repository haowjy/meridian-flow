import { createRequire } from "node:module";
import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { announceErrorMock, previewRef } = vi.hoisted(() => ({
  announceErrorMock: vi.fn(),
  previewRef: {
    current: {
      status: "active",
      draftId: "draft-1",
      liveRevisionToken: 3,
      draftRevisionToken: 7,
      inlineModelPresent: false,
    } as unknown,
  },
}));

vi.mock("@/client/query/useDraftPreview", () => ({
  useDraftPreview: () => ({ preview: previewRef.current, refetch: vi.fn() }),
}));
vi.mock("@/client/stores", () => ({ announceError: announceErrorMock }));

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis & { close: () => void } };
};

const { useInlineReviewSync } = await import("./useInlineReviewSync");

function mountedEditor(setInlineReviewModel = vi.fn()): Editor {
  return {
    isDestroyed: false,
    commands: { setInlineReviewModel },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Editor;
}

async function renderHook(input: {
  editor: Editor;
  onReviewSessionUnavailable: () => void;
}): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const rootNode = dom.window.document.getElementById("root");
    if (!rootNode) throw new Error("missing root");
    const root = createRoot(rootNode);
    function Harness() {
      useInlineReviewSync({
        editor: input.editor,
        liveSession: null,
        projectId: "project-1",
        workId: "work-1",
        documentId: "doc-1",
        draftId: "draft-1",
        enabled: true,
        onReviewSessionUnavailable: input.onReviewSessionUnavailable,
      });
      return null;
    }
    await act(async () => {
      root.render(<Harness />);
    });
    await act(async () => root.unmount());
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    dom.window.close();
  }
}

describe("useInlineReviewSync", () => {
  beforeEach(() => {
    announceErrorMock.mockClear();
  });

  it("exits review and announces an error when an active preview has no inline model", async () => {
    const onReviewSessionUnavailable = vi.fn();
    const editor = mountedEditor();

    await renderHook({ editor, onReviewSessionUnavailable });

    expect(onReviewSessionUnavailable).toHaveBeenCalledTimes(1);
    expect(announceErrorMock).toHaveBeenCalledWith(
      "Draft review is unavailable. Close the review and try again.",
    );
  });
});
