// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { commitLinkDraft, resolveLinkDraft } from "./link-commands";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function editorWith(content: string): Editor {
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content });
  return editor;
}

function firstLinkHref(target: Editor): string | null {
  let href: string | null = null;
  target.state.doc.descendants((node) => {
    const mark = node.marks.find((candidate) => candidate.type.name === "link");
    if (mark && href === null) href = String(mark.attrs.href);
  });
  return href;
}

describe("link draft resolution", () => {
  it("asks only for a URL over a selection", () => {
    const target = editorWith("<p>the third gate</p>");
    target.commands.setTextSelection({ from: 5, to: 14 });

    expect(resolveLinkDraft(target)).toMatchObject({ needsText: false, existing: false, href: "" });
  });

  it("asks for text and a URL at a bare caret", () => {
    const target = editorWith("<p>the third gate</p>");
    target.commands.setTextSelection(4);

    expect(resolveLinkDraft(target)).toMatchObject({ needsText: true, existing: false, text: "" });
  });

  it("pre-fills from the link under the caret", () => {
    const target = editorWith('<p><a href="https://example.com/gate">the gate</a> waits</p>');
    target.commands.setTextSelection(3);

    expect(resolveLinkDraft(target)).toMatchObject({
      existing: true,
      text: "the gate",
      href: "https://example.com/gate",
    });
  });
});

describe("link commit", () => {
  it("links the selected phrase", () => {
    const target = editorWith("<p>the third gate</p>");
    target.commands.setTextSelection({ from: 5, to: 14 });
    const draft = resolveLinkDraft(target);

    expect(commitLinkDraft(target, draft, { text: "", href: "example.com/gate" })).toBe("applied");
    expect(firstLinkHref(target)).toBe("https://example.com/gate");
    expect(target.state.doc.textContent).toBe("the third gate");
  });

  it("inserts a finished link at a bare caret", () => {
    const target = editorWith("<p></p>");
    target.commands.setTextSelection(1);
    const draft = resolveLinkDraft(target);

    expect(
      commitLinkDraft(target, draft, { text: "the gate", href: "https://example.com/gate" }),
    ).toBe("applied");
    expect(target.state.doc.textContent).toBe("the gate");
    expect(firstLinkHref(target)).toBe("https://example.com/gate");
  });

  it("rewrites the text of the link under the caret", () => {
    const target = editorWith('<p><a href="https://example.com/gate">the gate</a> waits</p>');
    target.commands.setTextSelection(3);
    const draft = resolveLinkDraft(target);

    expect(commitLinkDraft(target, draft, { text: "the third gate", href: draft.href })).toBe(
      "applied",
    );
    expect(target.state.doc.textContent).toBe("the third gate waits");
    expect(firstLinkHref(target)).toBe("https://example.com/gate");
  });

  it("falls back to the URL as its own label", () => {
    const target = editorWith("<p></p>");
    target.commands.setTextSelection(1);
    const draft = resolveLinkDraft(target);

    commitLinkDraft(target, draft, { text: "  ", href: "https://example.com/gate" });
    expect(target.state.doc.textContent).toBe("https://example.com/gate");
  });

  it("removes the link when the URL is emptied", () => {
    const target = editorWith('<p><a href="https://example.com/gate">the gate</a> waits</p>');
    target.commands.setTextSelection(3);
    const draft = resolveLinkDraft(target);

    expect(commitLinkDraft(target, draft, { text: draft.text, href: "" })).toBe("removed");
    expect(firstLinkHref(target)).toBeNull();
    expect(target.state.doc.textContent).toBe("the gate waits");
  });

  it("keeps the form open on a URL it cannot use", () => {
    const target = editorWith("<p>the third gate</p>");
    target.commands.setTextSelection({ from: 5, to: 14 });
    const draft = resolveLinkDraft(target);

    expect(commitLinkDraft(target, draft, { text: "", href: "javascript:alert(1)" })).toBe(
      "invalid",
    );
    expect(firstLinkHref(target)).toBeNull();
  });

  it("refuses a read-only document", () => {
    const target = editorWith("<p>the third gate</p>");
    target.commands.setTextSelection({ from: 5, to: 14 });
    const draft = resolveLinkDraft(target);
    target.setEditable(false);

    expect(commitLinkDraft(target, draft, { text: "", href: "https://example.com" })).toBe(
      "refused",
    );
    expect(firstLinkHref(target)).toBeNull();
  });
});
