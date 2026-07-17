// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";

import {
  type BubbleContext,
  isEditorBubbleFocusTarget,
  selectBubbleContext,
} from "./EditorBubbleHost";

const EmptyBubble: BubbleContext["Component"] = () => null;

function context(id: string, matches: boolean): BubbleContext {
  return {
    id,
    anchor: "selection",
    accessibleName: () => id,
    match: vi.fn(() => (matches ? { from: 1, to: 2, identity: id } : null)),
    Component: EmptyBubble,
  };
}

describe("selectBubbleContext", () => {
  it("uses registration order as context priority", () => {
    const editor = {} as Editor;
    const table = context("table", true);
    const image = context("image", true);
    const code = context("code", true);
    const link = context("link", true);

    expect(selectBubbleContext(editor, [table, image, code, link])?.context.id).toBe("table");
  });

  it("falls through inactive inner contexts", () => {
    const editor = {} as Editor;

    expect(
      selectBubbleContext(editor, [context("table", true), context("link", false)])?.context.id,
    ).toBe("table");
  });
});

describe("isEditorBubbleFocusTarget", () => {
  it("keeps focus in bubble-owned portalled content", () => {
    const bubble = document.createElement("div");
    const portal = document.createElement("div");
    portal.dataset.editorBubbleFocusScope = "";
    const input = portal.appendChild(document.createElement("input"));

    expect(isEditorBubbleFocusTarget(bubble, input)).toBe(true);
    expect(isEditorBubbleFocusTarget(bubble, document.createElement("input"))).toBe(false);
  });
});
