import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";

import { type BubbleContext, selectBubbleContext } from "./EditorBubbleHost";

const EmptyBubble: BubbleContext["Component"] = () => null;

function context(id: string, matches: boolean): BubbleContext {
  return {
    id,
    anchor: "selection",
    match: vi.fn(() => (matches ? { from: 1, to: 2 } : null)),
    Component: EmptyBubble,
  };
}

describe("selectBubbleContext", () => {
  it("uses editor context priority rather than registration order", () => {
    const editor = {} as Editor;
    const table = context("table", true);
    const image = context("image", true);
    const code = context("code", true);
    const link = context("link", true);

    expect(selectBubbleContext(editor, [table, image, code, link])?.context.id).toBe("link");
  });

  it("falls through inactive inner contexts", () => {
    const editor = {} as Editor;

    expect(
      selectBubbleContext(editor, [context("table", true), context("link", false)])?.context.id,
    ).toBe("table");
  });
});
