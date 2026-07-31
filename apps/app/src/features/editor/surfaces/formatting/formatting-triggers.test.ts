// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  type ChromeContext,
  type ContextClaimTarget,
  chromeContextAt,
  DOCUMENT_CHROME_CONTEXT,
  editorChromeAttributes,
  getEditorChrome,
  resolveChromeContext,
} from "@/core/editor/chrome";
import { createStandaloneEditorExtensions } from "@/core/editor/config";
import {
  claimsCaretFormattingMenu,
  claimsFormattingMenu,
  formattingMenuOpensFor,
  formattingOwnsContext,
  isProseSelection,
  placeCaretForMenu,
} from "./formatting-triggers";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function editorWith(content: string | JSONContent): Editor {
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content });
  return editor;
}

function proseElement(): HTMLElement {
  const element = document.createElement("p");
  document.body.appendChild(element);
  return element;
}

/** A portalled overlay row, marked the way the kernel asks a lane to mark it. */
function chromeElement(target: Editor): HTMLElement {
  const chrome = getEditorChrome(target);
  if (!chrome) throw new Error("the editor mounted no chrome");
  const row = document.createElement("div");
  for (const [attribute, value] of Object.entries(editorChromeAttributes(chrome))) {
    row.setAttribute(attribute, value);
  }
  const button = document.createElement("button");
  row.appendChild(button);
  document.body.appendChild(row);
  return button;
}

function rightClick(overrides: Partial<ContextClaimTarget> = {}): ContextClaimTarget {
  return {
    element: proseElement(),
    docPos: 3,
    context: DOCUMENT_CHROME_CONTEXT,
    insideTextSelection: true,
    event: { clientX: 120, clientY: 240, shiftKey: false } as MouseEvent,
    ...overrides,
  };
}

const objectContext: ChromeContext = {
  owner: "object",
  nodeType: "figure",
  objectSpec: "figure",
  pos: 8,
  objectPos: 8,
  chain: ["document", "object"],
};

function posInsideCell(target: Editor): number {
  let pos = -1;
  target.state.doc.descendants((node, at) => {
    if (pos < 0 && node.type.name === "table_cell") pos = at + 2;
  });
  if (pos < 0) throw new Error("no table cell in the document");
  return pos;
}

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
              type: "table_cell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Kael" }] }],
            },
          ],
        },
      ],
    },
  ],
};

const cellContext: ChromeContext = {
  owner: "table-cell",
  nodeType: "table_cell",
  objectSpec: null,
  pos: 4,
  objectPos: null,
  chain: ["document", "table", "table-cell"],
};

const FIGURE_DOC: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "He had rehearsed this" }] },
    { type: "figure", attrs: { src: "asset:figure-1", alt: "the third gate" } },
  ],
};

describe("the selection the formatting menu acts on", () => {
  it("takes a swept text selection", () => {
    const target = editorWith("<p>He had rehearsed this</p>");
    target.commands.setTextSelection({ from: 4, to: 12 });

    expect(isProseSelection(target.state)).toBe(true);
    expect(formattingMenuOpensFor(target)).toBe(true);
  });

  it("takes a select-all, which is how a writer reaches a whole chapter", () => {
    const target = editorWith("<p>He had rehearsed this</p><p>None of the rehearsals</p>");
    target.commands.selectAll();

    expect(isProseSelection(target.state)).toBe(true);
  });

  it("is not a selection at a bare caret, which the caret rung takes instead", () => {
    const target = editorWith("<p>He had reharsed this</p>");
    target.commands.setTextSelection(6);

    expect(isProseSelection(target.state)).toBe(false);
    // The keyboard twin still declines: Shift+F10 has no pointer, so there is
    // nowhere to move a caret to and nothing new to say about the one it has.
    expect(formattingMenuOpensFor(target)).toBe(false);
  });

  it("leaves a selected object to its own lane", () => {
    const target = editorWith(FIGURE_DOC);
    let figurePos = -1;
    target.state.doc.descendants((node, at) => {
      if (figurePos < 0 && node.type.name === "figure") figurePos = at;
    });
    target.commands.setNodeSelection(figurePos);

    expect(isProseSelection(target.state)).toBe(false);
  });

  it("declines a selected code fence, where the right-click declines too", () => {
    const target = editorWith("<pre><code>const gate = 3</code></pre>");
    target.commands.setTextSelection({ from: 1, to: 6 });

    // The selection is prose-shaped; the context is what refuses it.
    expect(isProseSelection(target.state)).toBe(true);
    expect(formattingOwnsContext(resolveChromeContext(target.state))).toBe(false);
    expect(formattingMenuOpensFor(target)).toBe(false);
  });

  it("opens over a selection inside a table cell, whose text is prose", () => {
    const target = editorWith(TABLE_DOC);
    const cell = posInsideCell(target);
    target.commands.setTextSelection({ from: cell, to: cell + 3 });

    expect(formattingMenuOpensFor(target)).toBe(true);
  });

  it("opens nothing on a read-only document, so the browser's menu stands", () => {
    const target = editorWith("<p>He had rehearsed this</p>");
    target.commands.setTextSelection({ from: 4, to: 12 });
    target.setEditable(false);

    expect(formattingMenuOpensFor(target)).toBe(false);
  });
});

describe("the right-click claim", () => {
  function selectedEditor(): Editor {
    const target = editorWith("<p>He had rehearsed this</p>");
    target.commands.setTextSelection({ from: 4, to: 12 });
    return target;
  }

  it("claims a selection the pointer is inside", () => {
    expect(claimsFormattingMenu(selectedEditor(), rightClick())).toBe(true);
  });

  it("declines a selection the pointer is not inside", () => {
    const target = selectedEditor();
    expect(claimsFormattingMenu(target, rightClick({ insideTextSelection: false }))).toBe(false);
  });

  it("declines an object under the pointer, selection or not", () => {
    const target = selectedEditor();
    expect(claimsFormattingMenu(target, rightClick({ context: objectContext }))).toBe(false);
  });

  it("declines inside a source block, which owns its own chrome (law 4)", () => {
    const target = editorWith("<pre><code>const gate = 3</code></pre>");
    target.commands.setTextSelection({ from: 1, to: 6 });
    const context = chromeContextAt(target.state.doc, 3);
    expect(context.owner).toBe("source-block");

    expect(claimsFormattingMenu(target, rightClick({ context }))).toBe(false);
  });

  it("claims a selection inside a table cell, whose text is prose (§5.4)", () => {
    const target = selectedEditor();

    expect(claimsFormattingMenu(target, rightClick({ context: cellContext }))).toBe(true);
  });

  it("declines a right-click on portalled chrome standing over the prose", () => {
    const target = selectedEditor();
    expect(claimsFormattingMenu(target, rightClick({ element: chromeElement(target) }))).toBe(
      false,
    );
  });

  it("declines on a read-only document, so the browser's menu stands", () => {
    const target = selectedEditor();
    target.setEditable(false);

    expect(claimsFormattingMenu(target, rightClick())).toBe(false);
  });
});

describe("the bare caret's claim", () => {
  function caretClick(overrides: Partial<ContextClaimTarget> = {}): ContextClaimTarget {
    return rightClick({ insideTextSelection: false, ...overrides });
  }

  it("claims a caret in a paragraph, so no right-click reaches the browser", () => {
    const target = editorWith("<p>He had rehearsed this</p>");
    target.commands.setTextSelection(6);

    expect(claimsCaretFormattingMenu(target, caretClick())).toBe(true);
  });

  it("claims a caret in a table cell, whose text is prose (§5.4)", () => {
    const target = editorWith(TABLE_DOC);
    target.commands.setTextSelection(posInsideCell(target));

    expect(claimsCaretFormattingMenu(target, caretClick({ context: cellContext }))).toBe(true);
  });

  it("leaves a code fence to the fence's own verbs (law 4)", () => {
    const target = editorWith("<pre><code>const gate = 3</code></pre>");
    const context = chromeContextAt(target.state.doc, 3);
    expect(context.owner).toBe("source-block");

    expect(claimsCaretFormattingMenu(target, caretClick({ context }))).toBe(false);
  });

  it("leaves an object to its own lane", () => {
    const target = editorWith(FIGURE_DOC);
    expect(claimsCaretFormattingMenu(target, caretClick({ context: objectContext }))).toBe(false);
  });

  it("declines portalled chrome standing over the prose", () => {
    const target = editorWith("<p>He had rehearsed this</p>");
    expect(claimsCaretFormattingMenu(target, caretClick({ element: chromeElement(target) }))).toBe(
      false,
    );
  });

  it("declines where the pointer left the prose and there is no place to aim", () => {
    const target = editorWith("<p>He had rehearsed this</p>");
    expect(claimsCaretFormattingMenu(target, caretClick({ docPos: null }))).toBe(false);
  });

  it("declines on a read-only document, so the browser's menu stands", () => {
    const target = editorWith("<p>He had rehearsed this</p>");
    target.setEditable(false);

    expect(claimsCaretFormattingMenu(target, caretClick())).toBe(false);
  });

  it("puts the caret where the writer pointed, so the verbs act on that block", () => {
    const target = editorWith("<p>First line</p><h2>Second line</h2>");
    target.commands.setTextSelection(3);

    expect(placeCaretForMenu(target, 16)).toBe(true);
    expect(target.state.selection.empty).toBe(true);
    expect(target.state.selection.$from.parent.type.name).toBe("heading");
  });
});
