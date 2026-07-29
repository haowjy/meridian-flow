// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { clipboardAccess, cutSelection, pasteIntoSelection } from "./clipboard-commands";

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

describe("what the clipboard reports back", () => {
  it("says a browser exposes neither direction rather than failing later", () => {
    stubClipboard({});

    expect(clipboardAccess()).toEqual({ read: "unavailable", write: "unavailable" });
  });

  it("reports a read the browser does not offer", async () => {
    stubClipboard({ writeText: vi.fn() });
    const target = editorWith("<p>Kael pressed</p>");

    await expect(pasteIntoSelection(target)).resolves.toBe("unavailable");
  });

  it("reports a read the browser refuses", async () => {
    stubClipboard({ read: vi.fn().mockRejectedValue(new Error("denied")) });
    const target = editorWith("<p>Kael pressed</p>");

    await expect(pasteIntoSelection(target)).resolves.toBe("denied");
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

  it("reports a clipboard holding nothing it can take", async () => {
    stubClipboard({ read: vi.fn().mockResolvedValue([plainTextItem("   ")]) });
    const target = editorWith("<p>Kael pressed</p>");

    await expect(pasteIntoSelection(target)).resolves.toBe("empty");
  });
});
