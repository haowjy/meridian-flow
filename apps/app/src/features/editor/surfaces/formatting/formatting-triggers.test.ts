// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  type ChromeContext,
  type ContextClaimTarget,
  chromeContextAt,
  DOCUMENT_CHROME_CONTEXT,
  EDITOR_CHROME_ATTRIBUTE,
  resolveContextClaim,
} from "@/core/editor/chrome";
import { createStandaloneEditorExtensions } from "@/core/editor/config";
import {
  claimsFormattingMenu,
  formattingMenuOpensFor,
  isProseSelection,
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

function chromeElement(): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute(EDITOR_CHROME_ATTRIBUTE, "");
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
    event: { clientX: 120, clientY: 240 } as MouseEvent,
    ...overrides,
  };
}

const objectContext: ChromeContext = {
  owner: "object",
  nodeType: "figure",
  pos: 8,
  chain: ["document", "object"],
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

  it("leaves the bare caret alone, where spellcheck lives (ruling 11)", () => {
    const target = editorWith("<p>He had reharsed this</p>");
    target.commands.setTextSelection(6);

    expect(isProseSelection(target.state)).toBe(false);
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
    const cellContext: ChromeContext = {
      owner: "table-cell",
      nodeType: "table_cell",
      pos: 4,
      chain: ["document", "table", "table-cell"],
    };

    expect(claimsFormattingMenu(target, rightClick({ context: cellContext }))).toBe(true);
  });

  it("declines a right-click on portalled chrome standing over the prose", () => {
    const target = selectedEditor();
    expect(claimsFormattingMenu(target, rightClick({ element: chromeElement() }))).toBe(false);
  });

  it("registers at the text-selection rung, under a link and over an object", () => {
    const target = selectedEditor();
    const formatting = {
      id: "text-selection" as const,
      claim: (claimTarget: ContextClaimTarget) => claimsFormattingMenu(target, claimTarget),
    };
    const link = { id: "link" as const, claim: () => true };

    expect(resolveContextClaim([formatting], rightClick())).toBe("text-selection");
    expect(resolveContextClaim([formatting, link], rightClick())).toBe("link");
  });
});
