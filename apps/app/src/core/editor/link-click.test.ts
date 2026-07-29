// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "./config";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("editable link clicks", () => {
  it("prevents browser navigation", () => {
    editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: '<p><a href="https://example.com">linked</a></p>',
    });
    const link = editor.view.dom.querySelector("a");
    if (!link) throw new Error("link was not rendered");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
  });
});
