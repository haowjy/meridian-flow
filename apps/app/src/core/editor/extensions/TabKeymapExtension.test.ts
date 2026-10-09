// @vitest-environment jsdom
/** Tab consumes the indent key without replacing a selected picture. */
import type { Editor, JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { installJsdomLayout } from "@/test-support/jsdom-layout";
import { createStandaloneEditor, type StandaloneEditor } from "@/test-support/standalone-editor";

let fixture: StandaloneEditor | null = null;

// Tab reaches prosemirror-tables, which asks the view where the textblock ends.
installJsdomLayout();

afterEach(() => {
  fixture?.destroy();
  fixture = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

function mount(content: JSONContent[], editable = true): Editor {
  fixture = createStandaloneEditor({ content: { type: "doc", content } });
  fixture.editor.setEditable(editable);
  return fixture.editor;
}

/** Press the key; true when something refused the browser's default. */
function pressTab(instance: Editor, shiftKey = false): boolean {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  instance.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("Tab makes a tab", () => {
  it("leaves a selected object alone: an indent key never replaces a picture", () => {
    const instance = mount([paragraph("before"), { type: "figure", attrs: { src: "asset:1" } }]);
    instance.commands.setNodeSelection(instance.state.doc.content.size - 1);

    expect(pressTab(instance)).toBe(true);
    expect(instance.state.doc.childCount).toBe(2);
    expect(instance.state.doc.textContent).toBe("before");
  });
});
