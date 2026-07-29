// @vitest-environment jsdom

import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import {
  canUndoDocument,
  documentToolbarControls,
  setToolbarAlignment,
  type ToolbarContext,
  toggleBulletListBlock,
  toggleHeadingBlock,
  toggleTextMark,
} from "./toolbar-commands";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function editorWith(content: string | JSONContent): Editor {
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content });
  return editor;
}

function controlsFor(target: Editor | null, overrides: Partial<ToolbarContext> = {}) {
  return documentToolbarControls({
    editor: target,
    editable: true,
    canUndo: false,
    canRedo: false,
    imageUploadAvailable: true,
    imageUploadBusy: false,
    ...overrides,
  });
}

function selectNodeOfType(target: Editor, typeName: string): void {
  let pos = -1;
  target.state.doc.descendants((node, at) => {
    if (pos < 0 && node.type.name === typeName) pos = at;
  });
  if (pos < 0) throw new Error(`no ${typeName} in the document`);
  target.commands.setNodeSelection(pos);
}

const FIGURE_DOC: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "prose" }] },
    { type: "figure", attrs: { src: "asset:figure-1", alt: "the third gate" } },
  ],
};

describe("toolbar enablement matrix", () => {
  it("enables every formatting verb at a caret in prose", () => {
    const controls = controlsFor(editorWith("<p>Kael pressed his palm flat</p>"));

    for (const id of ["heading", "bold", "italic", "code", "bulletList", "link"] as const) {
      expect(controls[id].blockedBy, id).toBeNull();
    }
    expect(controls.alignment.blockedBy).toBeNull();
    expect(controls.uploadFigure.blockedBy).toBeNull();
  });

  it("greys formatting and block-type verbs when an object node is selected", () => {
    const target = editorWith(FIGURE_DOC);
    selectNodeOfType(target, "figure");

    const controls = controlsFor(target);
    expect(controls.heading.blockedBy).toBe("object-selection");
    expect(controls.bulletList.blockedBy).toBe("object-selection");
    expect(controls.bold.blockedBy).toBe("object-selection");
    expect(controls.italic.blockedBy).toBe("object-selection");
    expect(controls.code.blockedBy).toBe("object-selection");
    expect(controls.link.blockedBy).toBe("object-selection");
    expect(controls.alignment.blockedBy).toBe("no-alignable-block");
    // A figure under the caret says nothing about uploading the next one.
    expect(controls.uploadFigure.blockedBy).toBeNull();
  });

  it("greys marks and block-type verbs inside a code block", () => {
    const target = editorWith("<pre><code>const gate = 3</code></pre>");
    target.commands.setTextSelection(3);

    const controls = controlsFor(target);
    expect(controls.bold.blockedBy).toBe("code-block");
    expect(controls.italic.blockedBy).toBe("code-block");
    expect(controls.code.blockedBy).toBe("code-block");
    expect(controls.heading.blockedBy).toBe("code-block");
    expect(controls.bulletList.blockedBy).toBe("code-block");
    // The link mark is refused by the same schema rule.
    expect(controls.link.blockedBy).toBe("code-block");
  });

  it("greys alignment where no alignable block sits under the selection", () => {
    const target = editorWith("<pre><code>const gate = 3</code></pre>");
    target.commands.setTextSelection(3);

    expect(controlsFor(target).alignment.blockedBy).toBe("no-alignable-block");
  });

  it("greys every control behind a read-only document, still reflecting state", () => {
    const target = editorWith("<h1>Chapter 214</h1>");
    target.commands.setTextSelection(3);

    const controls = controlsFor(target, { editable: false, canUndo: true, canRedo: true });
    for (const control of Object.values(controls)) {
      expect(control.blockedBy).toBe("document-read-only");
    }
    expect(controls.heading.active).toBe(true);
  });

  it("greys every control while the document is still opening", () => {
    const controls = controlsFor(null);

    for (const control of Object.values(controls)) {
      expect(control.blockedBy).toBe("editor-loading");
      expect(control.active).toBe(false);
    }
  });

  it("reports empty history honestly", () => {
    const target = editorWith("<p>a</p>");

    expect(controlsFor(target).undo.blockedBy).toBe("empty-history");
    expect(controlsFor(target).redo.blockedBy).toBe("empty-history");
    expect(controlsFor(target, { canUndo: true }).undo.blockedBy).toBeNull();
    // Undo is the Yjs UndoManager's; an editor without collaboration has none.
    expect(canUndoDocument(target)).toBe(false);
  });

  it("explains an upload that has no project and one already in flight", () => {
    const target = editorWith("<p>a</p>");

    expect(controlsFor(target, { imageUploadAvailable: false }).uploadFigure.blockedBy).toBe(
      "no-project",
    );
    expect(controlsFor(target, { imageUploadBusy: true }).uploadFigure.blockedBy).toBe(
      "upload-in-flight",
    );
  });
});

describe("block-type commands refuse non-text targets", () => {
  it("never converts a selected figure into a heading", () => {
    const target = editorWith(FIGURE_DOC);
    selectNodeOfType(target, "figure");

    expect(toggleHeadingBlock(target)).toBe(false);
    expect(target.state.doc.lastChild?.type.name).toBe("figure");
  });

  it("never wraps a selected figure in a list", () => {
    const target = editorWith(FIGURE_DOC);
    selectNodeOfType(target, "figure");

    expect(toggleBulletListBlock(target)).toBe(false);
    expect(target.state.doc.lastChild?.type.name).toBe("figure");
  });

  it("never converts a code block", () => {
    const target = editorWith("<pre><code>const gate = 3</code></pre>");
    target.commands.setTextSelection(3);

    expect(toggleHeadingBlock(target)).toBe(false);
    expect(toggleBulletListBlock(target)).toBe(false);
    expect(target.state.doc.firstChild?.type.name).toBe("code_block");
  });

  it("refuses every command on a read-only document", () => {
    const target = editorWith("<p>Kael</p>");
    target.commands.setTextSelection({ from: 1, to: 5 });
    target.setEditable(false);

    expect(toggleHeadingBlock(target)).toBe(false);
    expect(toggleTextMark(target, "strong")).toBe(false);
    expect(setToolbarAlignment(target, "center")).toBe(false);
    expect(target.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(target.state.doc.firstChild?.attrs.align).toBeNull();
  });
});

describe("toolbar toggles reverse", () => {
  it("returns an H1 to a paragraph on the second press", () => {
    const target = editorWith("<p>Chapter 214</p>");
    target.commands.setTextSelection(3);

    expect(toggleHeadingBlock(target)).toBe(true);
    expect(target.state.doc.firstChild?.type.name).toBe("heading");
    expect(controlsFor(target).heading.active).toBe(true);

    expect(toggleHeadingBlock(target)).toBe(true);
    expect(target.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(controlsFor(target).heading.active).toBe(false);
  });

  it("un-lists a bulleted block on the second press", () => {
    const target = editorWith("<p>one rehearsal</p>");
    target.commands.setTextSelection(3);

    toggleBulletListBlock(target);
    expect(target.state.doc.firstChild?.type.name).toBe("bullet_list");
    expect(controlsFor(target).bulletList.active).toBe(true);

    toggleBulletListBlock(target);
    expect(target.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(controlsFor(target).bulletList.active).toBe(false);
  });

  it("removes a mark on the second press", () => {
    const target = editorWith("<p>Kael pressed</p>");
    target.commands.setTextSelection({ from: 1, to: 5 });

    toggleTextMark(target, "strong");
    expect(controlsFor(target).bold.active).toBe(true);

    toggleTextMark(target, "strong");
    expect(controlsFor(target).bold.active).toBe(false);
  });

  it("returns block alignment to the default", () => {
    const target = editorWith("<p>a scene break</p>");
    target.commands.setTextSelection(3);

    setToolbarAlignment(target, "center");
    expect(target.state.doc.firstChild?.attrs.align).toBe("center");
    expect(controlsFor(target).alignment.active).toBe(true);

    setToolbarAlignment(target, "default");
    expect(target.state.doc.firstChild?.attrs.align).toBeNull();
    expect(controlsFor(target).alignment.active).toBe(false);
  });
});
