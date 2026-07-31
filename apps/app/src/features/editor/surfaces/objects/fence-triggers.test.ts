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
} from "@/core/editor/chrome";
import { createStandaloneEditorExtensions } from "@/core/editor/config";

import { fenceUnderPointer } from "./fence-triggers";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function editorWith(content: string | JSONContent): Editor {
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content });
  return editor;
}

/** A portalled chip cluster, marked the way the kernel asks a lane to mark it. */
function chromeElement(target: Editor): HTMLElement {
  const chrome = getEditorChrome(target);
  if (!chrome) throw new Error("the editor mounted no chrome");
  const cluster = document.createElement("div");
  for (const [attribute, value] of Object.entries(editorChromeAttributes(chrome))) {
    cluster.setAttribute(attribute, value);
  }
  const button = document.createElement("button");
  cluster.appendChild(button);
  document.body.appendChild(cluster);
  return button;
}

function rightClick(overrides: Partial<ContextClaimTarget> = {}): ContextClaimTarget {
  const element = document.createElement("code");
  document.body.appendChild(element);
  return {
    element,
    docPos: 3,
    context: DOCUMENT_CHROME_CONTEXT,
    insideTextSelection: false,
    event: { clientX: 120, clientY: 240, shiftKey: false } as MouseEvent,
    ...overrides,
  };
}

const objectContext: ChromeContext = {
  owner: "object",
  nodeType: "code_block",
  objectSpec: "diagram:mermaid",
  pos: 0,
  objectPos: 0,
  chain: ["document", "object"],
};

function fenceEditor(): Editor {
  return editorWith("<pre><code>const gate = 3</code></pre>");
}

describe("the caret in a code fence", () => {
  it("claims the fence the pointer is in, and names its position", () => {
    const target = fenceEditor();
    const context = chromeContextAt(target.state.doc, 3);
    expect(context.owner).toBe("source-block");

    expect(fenceUnderPointer(target, rightClick({ context }))).toBe(context.pos);
  });

  it("leaves a rendered diagram to the object rung", () => {
    const target = fenceEditor();
    expect(fenceUnderPointer(target, rightClick({ context: objectContext }))).toBeNull();
  });

  it("leaves prose to the formatting menu", () => {
    const target = editorWith("<p>He had rehearsed this</p>");
    expect(fenceUnderPointer(target, rightClick())).toBeNull();
  });

  it("declines the chip cluster standing over the fence, which is its own door", () => {
    const target = fenceEditor();
    const context = chromeContextAt(target.state.doc, 3);
    expect(fenceUnderPointer(target, rightClick({ context, element: chromeElement(target) }))).toBe(
      null,
    );
  });

  it("declines on a read-only document, so the browser's menu stands", () => {
    const target = fenceEditor();
    const context = chromeContextAt(target.state.doc, 3);
    target.setEditable(false);

    expect(fenceUnderPointer(target, rightClick({ context }))).toBeNull();
  });
});
