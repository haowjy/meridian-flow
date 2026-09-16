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

type Outcome = "claim" | "decline" | null;

function caretClick(overrides: Partial<ContextClaimTarget> = {}): ContextClaimTarget {
  return rightClick({ insideTextSelection: false, ...overrides });
}

function fixture(context: string): { editor: Editor; claim: ContextClaimTarget } {
  switch (context) {
    case "swept prose": {
      const instance = editorWith("<p>He had rehearsed this</p>");
      instance.commands.setTextSelection({ from: 4, to: 12 });
      return { editor: instance, claim: rightClick() };
    }
    case "a sweep the pointer missed": {
      const instance = editorWith("<p>He had rehearsed this</p>");
      instance.commands.setTextSelection({ from: 4, to: 12 });
      return { editor: instance, claim: rightClick({ insideTextSelection: false }) };
    }
    case "a bare caret in prose": {
      const instance = editorWith("<p>He had rehearsed this</p>");
      instance.commands.setTextSelection(6);
      return { editor: instance, claim: caretClick() };
    }
    case "an object": {
      const instance = editorWith(FIGURE_DOC);
      let figurePos = -1;
      instance.state.doc.descendants((node, at) => {
        if (figurePos < 0 && node.type.name === "figure") figurePos = at;
      });
      instance.commands.setNodeSelection(figurePos);
      return { editor: instance, claim: rightClick({ context: objectContext }) };
    }
    case "a source block": {
      const instance = editorWith("<pre><code>const gate = 3</code></pre>");
      instance.commands.setTextSelection({ from: 1, to: 6 });
      const chrome = chromeContextAt(instance.state.doc, 3);
      return { editor: instance, claim: rightClick({ context: chrome }) };
    }
    case "a table cell": {
      const instance = editorWith(TABLE_DOC);
      const cell = posInsideCell(instance);
      instance.commands.setTextSelection({ from: cell, to: cell + 3 });
      return { editor: instance, claim: rightClick({ context: cellContext }) };
    }
    case "portalled chrome": {
      const instance = editorWith("<p>He had rehearsed this</p>");
      instance.commands.setTextSelection({ from: 4, to: 12 });
      return { editor: instance, claim: rightClick({ element: chromeElement(instance) }) };
    }
    case "a read-only document": {
      const instance = editorWith("<p>He had rehearsed this</p>");
      instance.commands.setTextSelection({ from: 4, to: 12 });
      instance.setEditable(false);
      return { editor: instance, claim: rightClick() };
    }
    case "no document position": {
      const instance = editorWith("<p>He had rehearsed this</p>");
      return { editor: instance, claim: caretClick({ docPos: null }) };
    }
    default:
      throw new Error(`unknown context ${context}`);
  }
}

describe("context × gesture", () => {
  it.each([
    { context: "swept prose", selection: "claim", rightClick: "claim", caret: null },
    {
      context: "a sweep the pointer missed",
      selection: null,
      rightClick: "decline",
      caret: null,
    },
    {
      context: "a bare caret in prose",
      selection: "decline",
      rightClick: null,
      caret: "claim",
    },
    {
      context: "an object",
      selection: "decline",
      rightClick: "decline",
      caret: "decline",
    },
    {
      context: "a source block",
      selection: "decline",
      rightClick: "decline",
      caret: "decline",
    },
    {
      context: "a table cell",
      selection: "claim",
      rightClick: "claim",
      caret: "claim",
    },
    {
      context: "portalled chrome",
      selection: null,
      rightClick: "decline",
      caret: "decline",
    },
    {
      context: "a read-only document",
      selection: "decline",
      rightClick: "decline",
      caret: "decline",
    },
    {
      context: "no document position",
      selection: null,
      rightClick: null,
      caret: "decline",
    },
  ] satisfies {
    context: string;
    selection: Outcome;
    rightClick: Outcome;
    caret: Outcome;
  }[])("$context → selection $selection, right-click $rightClick, caret $caret", (row) => {
    const { editor: instance, claim } = fixture(row.context);

    if (row.selection !== null) {
      expect(formattingMenuOpensFor(instance)).toBe(row.selection === "claim");
    }
    if (row.rightClick !== null) {
      expect(claimsFormattingMenu(instance, claim)).toBe(row.rightClick === "claim");
    }
    if (row.caret !== null) {
      expect(claimsCaretFormattingMenu(instance, { ...claim, insideTextSelection: false })).toBe(
        row.caret === "claim",
      );
    }

    if (row.context === "swept prose" || row.context === "a table cell") {
      expect(isProseSelection(instance.state)).toBe(true);
    }
    if (row.context === "a bare caret in prose" || row.context === "an object") {
      expect(isProseSelection(instance.state)).toBe(false);
    }
    if (row.context === "a source block") {
      expect(claim.context.owner).toBe("source-block");
      expect(isProseSelection(instance.state)).toBe(true);
      expect(formattingOwnsContext(resolveChromeContext(instance.state))).toBe(false);
    }
  });
});

it("takes a select-all, which is how a writer reaches a whole chapter", () => {
  const target = editorWith("<p>He had rehearsed this</p><p>None of the rehearsals</p>");
  target.commands.selectAll();

  expect(isProseSelection(target.state)).toBe(true);
});

it("puts the caret where the writer pointed, so the verbs act on that block", () => {
  const target = editorWith("<p>First line</p><h2>Second line</h2>");
  target.commands.setTextSelection(3);

  expect(placeCaretForMenu(target, 16)).toBe(true);
  expect(target.state.selection.empty).toBe(true);
  expect(target.state.selection.$from.parent.type.name).toBe("heading");
});
