// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import type { ClipboardAccess } from "./clipboard-commands";
import { clipboardItemStates } from "./clipboard-menu";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function statesFor(clipboard: Partial<ClipboardAccess> = {}, editable = true) {
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: "<p>He had rehearsed this</p>",
  });
  editor.setEditable(editable);
  return clipboardItemStates(editor, { read: "available", write: "available", ...clipboard });
}

/**
 * The block the formatting menu and the link menu both mount, so this table is
 * the one answer a writer meets in either.
 */
describe("the clipboard block's greying", () => {
  it("offers all three where the browser hands the page its clipboard", () => {
    const states = statesFor();

    expect(states.cut.blockedBy).toBeNull();
    expect(states.copy.blockedBy).toBeNull();
    expect(states.paste.blockedBy).toBeNull();
  });

  it("greys Paste with its own reason where the browser withholds the clipboard", () => {
    const states = statesFor({ read: "unavailable" });

    expect(states.paste.blockedBy).toBe("clipboard-read-blocked");
    // The two directions are withheld separately.
    expect(states.cut.blockedBy).toBeNull();
    expect(states.copy.blockedBy).toBeNull();
  });

  it("greys Cut and Copy where the browser withholds clipboard writes", () => {
    const states = statesFor({ write: "unavailable" });

    expect(states.copy.blockedBy).toBe("clipboard-write-blocked");
    expect(states.cut.blockedBy).toBe("clipboard-write-blocked");
    expect(states.paste.blockedBy).toBeNull();
  });

  it("greys every verb but Copy on a document that turned read only", () => {
    const states = statesFor({}, false);

    expect(states.cut.blockedBy).toBe("document-read-only");
    expect(states.paste.blockedBy).toBe("document-read-only");
    // Copying is reading, and reading survives.
    expect(states.copy.blockedBy).toBeNull();
  });
});
