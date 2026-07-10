import type { Editor } from "@tiptap/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

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
  await withReactRoot(<Harness />);
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
