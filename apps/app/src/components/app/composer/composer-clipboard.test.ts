// @vitest-environment jsdom
/** Clipboard round trips keep reference identity, not upload ownership. */
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { expect, it } from "vitest";
import { ComposerReferenceNode, serializeComposerDraft } from "./composer-document";

it("copies a reference as scoped Markdown and restores its structured identity", () => {
  const reference = {
    documentId: "01900000-0000-7000-8000-000000000001",
    uri: "uploads://@revision/notes.md",
    fileType: "markdown",
    authority: {
      kind: "work",
      projectId: "01900000-0000-7000-8000-000000000002",
      workId: "01900000-0000-7000-8000-000000000003",
      workSlug: "revision",
    },
    label: "Notes",
    displayText: "My notes",
    spelling: "[[Notes]]",
    imageCapable: false,
    upload: {
      intakeId: "owned",
      documentId: "01900000-0000-7000-8000-000000000001",
      uri: "uploads://@revision/notes.md",
      locationRevision: "1",
    },
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
    expect(copied.text).toBe("[[uploads://@revision/notes.md|My notes]]");
    editor.commands.clearContent();
    editor.view.pasteHTML(copied.dom.innerHTML, new Event("paste") as ClipboardEvent);
    expect(editor.state.doc.firstChild?.firstChild?.attrs.reference).toEqual({
      ...reference,
      upload: null,
    });
    const submitted = serializeComposerDraft(editor.getJSON(), 1, { anchor: 1, head: 1 });
    expect(submitted.draft.ownedUploads).toEqual([]);
    expect(submitted.references[0]?.purpose).toBe("reference");
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

it.each([
  { documentId: "not-a-uuid" },
  { uri: "javascript:alert(1)" },
  { fileType: "unknown-type" },
  { uri: "scratch://@another/notes.md" },
])("rejects semantically invalid clipboard identity %j", (invalid) => {
  const element = document.createElement("span");
  element.textContent = "Readable fallback";
  element.setAttribute(
    "data-composer-reference",
    JSON.stringify({
      documentId: "01900000-0000-7000-8000-000000000001",
      uri: "scratch://@revision/notes.md",
      fileType: "markdown",
      label: "Notes",
      spelling: "[[Notes]]",
      imageCapable: false,
      upload: null,
      authority: {
        kind: "work",
        projectId: "01900000-0000-7000-8000-000000000002",
        workId: "01900000-0000-7000-8000-000000000003",
        workSlug: "revision",
      },
      ...invalid,
    }),
  );
  const editor = new Editor({ extensions: [StarterKit, ComposerReferenceNode] });
  try {
    editor.view.pasteHTML(element.outerHTML, new Event("paste") as ClipboardEvent);
    expect(editor.state.doc.textContent).toBe("Readable fallback");
  } finally {
    editor.destroy();
  }
});

it("normalizes copied UUIDs before deduplicating reference identity", () => {
  const id = "abcdef12-3456-4789-abcd-1234567890ab";
  const payload = {
    documentId: id,
    uri: "scratch://@revision/notes.md",
    fileType: "markdown",
    label: "Notes",
    spelling: "[[Notes]]",
    imageCapable: false,
    upload: null,
    authority: { kind: "work", projectId: id, workId: id, workSlug: "revision" },
  };
  const html = [
    payload,
    {
      ...payload,
      documentId: id.toUpperCase(),
      authority: { ...payload.authority, projectId: id.toUpperCase(), workId: id.toUpperCase() },
    },
  ]
    .map((value) => {
      const span = document.createElement("span");
      span.setAttribute("data-composer-reference", JSON.stringify(value));
      span.textContent = "Notes";
      return span.outerHTML;
    })
    .join("");
  const editor = new Editor({ extensions: [StarterKit, ComposerReferenceNode] });
  try {
    editor.view.pasteHTML(html, new Event("paste") as ClipboardEvent);
    const result = serializeComposerDraft(editor.getJSON(), 1, { anchor: 1, head: 1 });
    expect(result.references).toHaveLength(1);
    expect(editor.state.doc.firstChild?.lastChild?.attrs.reference.authority).toEqual(
      payload.authority,
    );
  } finally {
    editor.destroy();
  }
});
