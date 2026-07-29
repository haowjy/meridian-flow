// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import {
  canUndoDocument,
  documentToolbarControls,
  setToolbarAlignment,
  type ToolbarContext,
  toggleBulletListBlock,
  toggleCodeBlockBlock,
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
    schemaType: "document",
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

function posInsideType(target: Editor, typeName: string): number {
  let pos = -1;
  target.state.doc.descendants((node, at) => {
    if (pos < 0 && node.type.name === typeName) pos = at + 1;
  });
  if (pos < 0) throw new Error(`no ${typeName} in the document`);
  return pos;
}

const FIGURE_DOC: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "prose" }] },
    { type: "figure", attrs: { src: "asset:figure-1", alt: "the third gate" } },
  ],
};

const FENCE_DOC: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Kael pressed his palm flat" }] },
    {
      type: "code_block",
      attrs: { language: "mermaid" },
      content: [{ type: "text", text: "graph TD; A --> B" }],
    },
    { type: "paragraph", content: [{ type: "text", text: "The panel unfolded" }] },
  ],
};

const JSX_DOC: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "prose" }] },
    {
      type: "jsx_leaf",
      attrs: { name: "StatBlock", props: { level: 47 } },
      content: [{ type: "text", text: "level=47" }],
    },
  ],
};

const TABLE_DOC: JSONContent = {
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "table_row",
          content: [
            {
              type: "table_header",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Status" }] }],
            },
            {
              type: "table_cell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Kael" }] }],
            },
          ],
        },
      ],
    },
  ],
};

describe("toolbar enablement matrix", () => {
  it("enables every formatting verb at a caret in prose", () => {
    const controls = controlsFor(editorWith("<p>Kael pressed his palm flat</p>"));

    for (const id of ["heading", "bold", "italic", "codeBlock", "bulletList", "link"] as const) {
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
    expect(controls.codeBlock.blockedBy).toBe("object-selection");
    expect(controls.link.blockedBy).toBe("object-selection");
    expect(controls.alignment.blockedBy).toBe("no-alignable-block");
    // A figure under the caret says nothing about uploading the next one.
    expect(controls.uploadFigure.blockedBy).toBeNull();
  });

  it("greys marks and the other block-type verbs inside a code block", () => {
    const target = editorWith("<pre><code>const gate = 3</code></pre>");
    target.commands.setTextSelection(3);

    const controls = controlsFor(target);
    expect(controls.bold.blockedBy).toBe("code-block");
    expect(controls.italic.blockedBy).toBe("code-block");
    expect(controls.heading.blockedBy).toBe("code-block");
    expect(controls.bulletList.blockedBy).toBe("code-block");
    // The link mark is refused by the same schema rule.
    expect(controls.link.blockedBy).toBe("code-block");
    // The code-block control is the exception: a code block is what it
    // reverses, so here it is lit and live rather than greyed.
    expect(controls.codeBlock.active).toBe(true);
    expect(controls.codeBlock.blockedBy).toBeNull();
  });

  it("greys block-type verbs when a selection reaches across a code block", () => {
    const target = editorWith(FENCE_DOC);
    target.commands.selectAll();

    const controls = controlsFor(target);
    expect(controls.heading.blockedBy).toBe("mixed-selection");
    expect(controls.bulletList.blockedBy).toBe("mixed-selection");
    // Converting the prose around a fence would strip the fence's language
    // with it, so the code-block control refuses this one too.
    expect(controls.codeBlock.blockedBy).toBe("mixed-selection");
    // Marks land per node, so they stay live over the prose in the selection.
    expect(controls.bold.blockedBy).toBeNull();
  });

  it("greys block-type verbs on a selected registered component", () => {
    const target = editorWith(JSX_DOC);
    selectNodeOfType(target, "jsx_leaf");

    const controls = controlsFor(target);
    expect(controls.heading.blockedBy).toBe("embedded-block");
    expect(controls.bulletList.blockedBy).toBe("embedded-block");
    expect(controls.codeBlock.blockedBy).toBe("embedded-block");
    expect(controls.bold.blockedBy).toBe("embedded-block");
  });

  it("greys block-type verbs inside a table cell", () => {
    const target = editorWith(TABLE_DOC);
    target.commands.setTextSelection(posInsideType(target, "table_cell") + 1);

    const controls = controlsFor(target);
    expect(controls.heading.blockedBy).toBe("table-cell");
    expect(controls.bulletList.blockedBy).toBe("table-cell");
    expect(controls.codeBlock.blockedBy).toBe("table-cell");
    // Cells are prose: marks and links belong there.
    expect(controls.bold.blockedBy).toBeNull();
    expect(controls.link.blockedBy).toBeNull();
  });

  it("greys the marks that inline code excludes", () => {
    const target = editorWith("<p>the <code>third</code> gate</p>");
    target.commands.setTextSelection({ from: 5, to: 10 });

    const controls = controlsFor(target);
    expect(controls.bold.blockedBy).toBe("inline-code");
    expect(controls.italic.blockedBy).toBe("inline-code");
    expect(controls.link.blockedBy).toBe("inline-code");
    // The paragraph holding the inline code is still prose, so fencing it is
    // a legal conversion.
    expect(controls.codeBlock.blockedBy).toBeNull();
    expect(controls.codeBlock.active).toBe(false);
  });

  it("keeps alignment live across a multi-block selection", () => {
    const target = editorWith("<h1>Chapter 214</h1><p>Kael pressed</p><p>The panel</p>");
    target.commands.selectAll();

    expect(controlsFor(target).alignment.blockedBy).toBeNull();
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

  it("explains an upload a code file, a missing project, or a busy one cannot take", () => {
    const target = editorWith("<p>a</p>");

    expect(controlsFor(target, { schemaType: "code" }).uploadFigure.blockedBy).toBe(
      "code-document",
    );
    // History still belongs to the writer on a code file.
    expect(controlsFor(target, { schemaType: "code", canUndo: true }).undo.blockedBy).toBeNull();
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

  it("never converts a code block to a heading or a list", () => {
    const target = editorWith("<pre><code>const gate = 3</code></pre>");
    target.commands.setTextSelection(3);

    expect(toggleHeadingBlock(target)).toBe(false);
    expect(toggleBulletListBlock(target)).toBe(false);
    expect(target.state.doc.firstChild?.type.name).toBe("code_block");
  });

  it("never converts a fence caught in a select-all", () => {
    const target = editorWith(FENCE_DOC);
    target.commands.selectAll();

    expect(toggleHeadingBlock(target)).toBe(false);
    expect(toggleBulletListBlock(target)).toBe(false);
    expect(toggleCodeBlockBlock(target)).toBe(false);
    const fence = target.state.doc.child(1);
    expect(fence.type.name).toBe("code_block");
    expect(fence.attrs.language).toBe("mermaid");
    expect(target.state.doc.firstChild?.type.name).toBe("paragraph");
  });

  it("never converts a registered component", () => {
    const target = editorWith(JSX_DOC);
    selectNodeOfType(target, "jsx_leaf");

    expect(toggleHeadingBlock(target)).toBe(false);
    expect(toggleBulletListBlock(target)).toBe(false);
    expect(toggleCodeBlockBlock(target)).toBe(false);
    const component = target.state.doc.lastChild;
    expect(component?.type.name).toBe("jsx_leaf");
    expect(component?.attrs.name).toBe("StatBlock");
  });

  it("never converts the paragraph a table cell is built from", () => {
    const target = editorWith(TABLE_DOC);
    target.commands.setTextSelection(posInsideType(target, "table_cell") + 1);

    expect(toggleHeadingBlock(target)).toBe(false);
    expect(toggleBulletListBlock(target)).toBe(false);
    expect(toggleCodeBlockBlock(target)).toBe(false);
    expect(target.state.doc.firstChild?.type.name).toBe("table");
  });

  it("refuses a mark that inline code excludes", () => {
    const target = editorWith("<p>the <code>third</code> gate</p>");
    target.commands.setTextSelection({ from: 5, to: 10 });

    expect(toggleTextMark(target, "strong")).toBe(false);
    expect(target.state.doc.textContent).toBe("the third gate");
    expect(controlsFor(target).bold.active).toBe(false);
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

  it("fences a paragraph and returns it to prose on the second press", () => {
    const target = editorWith("<p>graph TD; A to B</p>");
    target.commands.setTextSelection(3);

    expect(toggleCodeBlockBlock(target)).toBe(true);
    expect(target.state.doc.firstChild?.type.name).toBe("code_block");
    expect(controlsFor(target).codeBlock.active).toBe(true);

    expect(toggleCodeBlockBlock(target)).toBe(true);
    expect(target.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(controlsFor(target).codeBlock.active).toBe(false);
    expect(target.state.doc.textContent).toBe("graph TD; A to B");
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

  it("un-lists a nested item in one press", () => {
    const target = editorWith("<ul><li><p>outer</p><ul><li><p>inner</p></li></ul></li></ul>");
    let innerParagraph = -1;
    target.state.doc.descendants((node, at) => {
      if (node.type.name === "paragraph") innerParagraph = at + 1;
    });
    target.commands.setTextSelection(innerParagraph + 1);

    expect(toggleBulletListBlock(target)).toBe(true);
    expect(controlsFor(target).bulletList.active).toBe(false);
    expect(target.state.doc.textContent).toContain("inner");
  });

  it("un-lists a whole list caught in a select-all", () => {
    const target = editorWith("<ul><li><p>one</p></li><li><p>two</p></li></ul>");
    target.commands.selectAll();

    expect(toggleBulletListBlock(target)).toBe(true);
    expect(controlsFor(target).bulletList.active).toBe(false);
    expect(target.state.doc.firstChild?.type.name).toBe("paragraph");
  });

  it("still toggles the inline code mark for the surfaces that carry it", () => {
    // The toolbar's Code button fences blocks now; the mark verb keeps its
    // command here for Ctrl+E's siblings (formatting menu, block menu).
    const target = editorWith("<p>the third gate</p>");
    target.commands.setTextSelection({ from: 5, to: 15 });

    expect(toggleTextMark(target, "code")).toBe(true);
    expect(target.isActive("code")).toBe(true);
    expect(toggleTextMark(target, "code")).toBe(true);
    expect(target.isActive("code")).toBe(false);
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

  it("aligns every block the selection covers", () => {
    const target = editorWith("<h1>Chapter 214</h1><p>Kael pressed</p><p>The panel</p>");
    target.commands.selectAll();

    expect(setToolbarAlignment(target, "center")).toBe(true);
    for (let index = 0; index < target.state.doc.childCount; index += 1) {
      expect(target.state.doc.child(index).attrs.align, `block ${index}`).toBe("center");
    }
  });
});
