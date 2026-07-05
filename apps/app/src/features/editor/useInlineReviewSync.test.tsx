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
  await renderHookSequence({
    editors: [input.editor],
    onReviewSessionUnavailable: input.onReviewSessionUnavailable,
  });
}

async function renderHookSequence(input: {
  editors: Editor[];
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
    function Harness({ editor }: { editor: Editor }) {
      useInlineReviewSync({
        editor,
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
    for (const editor of input.editors) {
      await act(async () => {
        root.render(<Harness editor={editor} />);
      });
    }
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
    previewRef.current = {
      status: "active",
      draftId: "draft-1",
      liveRevisionToken: 3,
      draftRevisionToken: 7,
      inlineModelPresent: false,
    };
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

  it("pushes the same preview identity again when the editor instance changes", async () => {
    previewRef.current = {
      status: "active",
      draftId: "draft-1",
      liveRevisionToken: 3,
      draftRevisionToken: 7,
      inlineModelPresent: true,
      operations: [
        {
          operationId: "op-1",
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
      ],
      hunks: [],
    };
    const setModelA = vi.fn();
    const setModelB = vi.fn();

    await renderHookSequence({
      editors: [mountedEditor(setModelA), mountedEditor(setModelB)],
      onReviewSessionUnavailable: vi.fn(),
    });

    expect(setModelA).toHaveBeenCalledTimes(1);
    expect(setModelB).toHaveBeenCalledTimes(1);
    expect(setModelB).toHaveBeenCalledWith(
      expect.objectContaining({
        draftRevisionToken: 7,
        operations: [expect.objectContaining({ operationId: "op-1" })],
      }),
    );
  });
});
