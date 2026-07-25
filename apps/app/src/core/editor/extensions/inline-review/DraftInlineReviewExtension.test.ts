// @vitest-environment jsdom
/** Mounted editor behavior for inline review navigation. */
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createEditorConfig } from "../../config";
import { buildInlineReviewModel } from "./model";

let editor: Editor;

function encodeAnchor(position: Y.RelativePosition): string {
  return Buffer.from(Y.encodeRelativePosition(position)).toString("base64");
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  editor?.destroy();
  vi.unstubAllGlobals();
});

describe("DraftInlineReviewExtension", () => {
  it("focuses and scrolls a visible pure-deletion seam without restoring deleted prose", () => {
    const document = new Y.Doc({ gc: false });
    const fragment = document.getXmlFragment("prosemirror");
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    fragment.insert(0, [paragraph]);
    paragraph.insert(0, [text]);
    text.insert(0, "Surviving manuscript.");
    const anchor = encodeAnchor(Y.createRelativePositionFromTypeIndex(text, 0));
    const root = globalThis.document.createElement("div");
    globalThis.document.body.append(root);
    editor = new Editor({
      element: root,
      ...createEditorConfig({
        document,
        awareness: new Awareness(document),
        enableDraftInlineReview: true,
      }),
    });
    const model = buildInlineReviewModel({
      draftRevisionToken: 1,
      operations: [
        {
          operationId: "op-ai",
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "edited",
          classification: "rewrite",
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          hunkId: "delete-1",
          operationIds: ["op-ai"],
          anchor: { relStart: anchor, relEnd: anchor },
          kind: "text",
          spans: [],
          deletedText: "Removed live-only sentence.",
        },
      ],
    });

    expect(editor.commands.setInlineReviewModel(model)).toBe(true);
    const idle = root.querySelector<HTMLElement>('[data-review-operations~="op-ai"]');
    expect(idle?.classList.contains("meridian-review-deletion-anchor")).toBe(true);
    expect(idle?.textContent).toBe("");
    expect(root.textContent).toContain("Surviving manuscript.");
    expect(root.textContent).not.toContain("Removed live-only sentence.");

    expect(editor.commands.setInlineReviewActiveOperation("op-ai")).toBe(true);
    const focused = root.querySelector<HTMLElement>('[data-review-operations~="op-ai"]');
    expect(focused).not.toBe(idle);
    expect(focused?.classList.contains("meridian-review-emphasized")).toBe(true);

    const scrollIntoView = vi.fn();
    Object.defineProperty(focused, "scrollIntoView", { value: scrollIntoView });
    expect(editor.commands.scrollInlineReviewOperationIntoView("op-ai")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
  });
});
