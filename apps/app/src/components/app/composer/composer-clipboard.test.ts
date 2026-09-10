// @vitest-environment jsdom
/** Clipboard round trips keep reference identity, not upload ownership. */
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, it } from "vitest";
import { ComposerReferenceNode } from "./composer-document";

it("copies a reference as scoped Markdown and restores its structured identity", () => {
  const reference = {
    documentId: "01900000-0000-7000-8000-000000000001",
    uri: "scratch://@revision/notes.md",
    fileType: "markdown",
    authority: { kind: "work", projectId: "project-1", workId: "work-1", workSlug: "revision" },
    label: "Notes",
    displayText: "My notes",
    spelling: "[[Notes]]",
    imageCapable: false,
    upload: null,
  };
  const editor = new Editor({
    extensions: [StarterKit, ComposerReferenceNode],
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "composerReference", attrs: { reference } }] },
      ],
    },
  });
  try {
    editor.commands.selectAll();
    const copied = editor.view.serializeForClipboard(editor.state.selection.content());
    expect(copied.text).toBe("[[scratch://@revision/notes.md|My notes]]");
    editor.commands.clearContent();
    editor.view.pasteHTML(copied.dom.innerHTML, new Event("paste") as ClipboardEvent);
    expect(editor.state.doc.firstChild?.firstChild?.attrs.reference).toEqual(reference);
  } finally {
    editor.destroy();
  }
});

it("preserves manuscript reference Markdown without inventing attachment identity", () => {
  const editor = new Editor({ extensions: [StarterKit, ComposerReferenceNode] });
  try {
    editor.view.pasteHTML(
      '<a data-meridian-link="[[scratch://@/notes.md]]">My notes</a>',
      new Event("paste") as ClipboardEvent,
    );
    expect(editor.state.doc.textContent).toBe("[[scratch://@/notes.md|My notes]]");
  } finally {
    editor.destroy();
  }
});

it.each(['{"label":"broken"}', "not JSON"])("ignores malformed reference metadata %s", (raw) => {
  const element = document.createElement("span");
  element.setAttribute("data-composer-reference", raw);
  element.textContent = "Still readable";
  const editor = new Editor({ extensions: [StarterKit, ComposerReferenceNode] });
  try {
    editor.view.pasteHTML(element.outerHTML, new Event("paste") as ClipboardEvent);
    expect(editor.state.doc.textContent).toBe("Still readable");
  } finally {
    editor.destroy();
  }
});
