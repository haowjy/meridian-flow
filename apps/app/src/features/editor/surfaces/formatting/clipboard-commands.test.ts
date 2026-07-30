// @vitest-environment jsdom
/**
 * The document half of the menu's clipboard: what a selection means, and what a
 * browser refusal does to the document.
 *
 * Capability and the shape of a refusal belong to the one clipboard boundary and
 * are tested there ([`../../clipboard.test.ts`](../../clipboard.test.ts)); what
 * these cases own is the part no adapter can answer — a cut may not delete words
 * the clipboard never took, and a paste may not quietly retouch what it pastes.
 */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { cutSelection, pasteIntoSelection } from "./clipboard-commands";

let editor: Editor | null = null;
const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

// jsdom ships no `ClipboardEvent`, and ProseMirror's own `pasteText` builds one
// when it is not handed an event. The browser has it; the harness does not.
if (typeof globalThis.ClipboardEvent === "undefined") {
  class StubClipboardEvent extends Event {}
  Object.defineProperty(globalThis, "ClipboardEvent", { value: StubClipboardEvent });
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

function editorWith(content: string): Editor {
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content });
  return editor;
}

/** A clipboard with only the parts the test cares about, as a browser exposes it. */
function stubClipboard(clipboard: Partial<Clipboard>): void {
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
}

function plainTextItem(text: string): ClipboardItem {
  return {
    types: ["text/plain"],
    getType: async () => ({ text: async () => text }) as Blob,
  } as unknown as ClipboardItem;
}

describe("what a refused clipboard does to the document", () => {
  it("passes a withheld direction through in the vocabulary a row greys from", async () => {
    stubClipboard({ writeText: vi.fn() });
    const target = editorWith("<p>Kael pressed</p>");

    await expect(pasteIntoSelection(target)).resolves.toBe("unavailable");
  });

  it("keeps the writer's words when a cut cannot reach the clipboard", async () => {
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    const target = editorWith("<p>Kael pressed</p>");
    target.commands.setTextSelection({ from: 1, to: 5 });

    await expect(cutSelection(target)).resolves.toBe("denied");
    // A cut whose copy failed would take the words with nothing to paste back.
    expect(target.state.doc.textContent).toBe("Kael pressed");
  });
});

describe("what the clipboard hands to the document", () => {
  it("pastes plain text with its own spacing intact", async () => {
    const indented = "    a line that means its indentation";
    stubClipboard({ read: vi.fn().mockResolvedValue([plainTextItem(indented)]) });
    const target = editorWith("<p></p>");

    await expect(pasteIntoSelection(target)).resolves.toBe("done");
    expect(target.state.doc.textContent).toBe(indented);
  });
});
