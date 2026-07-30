// @vitest-environment jsdom
/**
 * The clipboard block: what it offers before the writer presses, and what it
 * says when the browser refuses the press.
 *
 * Two menus mount this block, so both halves are one answer. The greying table
 * is capability seen in advance; the refusal cases are the answer that can only
 * arrive after the press, from a browser that hands the page a clipboard object
 * and then refuses this direction of it. A row that closed the menu on that
 * press reported success by disappearing, and the greying it set landed on a row
 * that no longer existed (law 5's silent rejection, in its most convincing
 * form).
 */
import { Editor } from "@tiptap/core";
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { createReactEditorFixture, type ReactEditorFixture } from "@/test-support/react-editor";

import { EditorMenu } from "../../chrome";
import type { ClipboardAccess } from "../../clipboard";
import { ClipboardMenuItems, clipboardItemStates } from "./clipboard-menu";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + String(values[index - 1] ?? "") + part),
}));

const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
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

/**
 * The block as both menus mount it: a controlled `EditorMenu` that closes when
 * the block says the verb ran. FormattingMenu closes by dropping its anchor and
 * LinkMenu by asking its surface, and neither can tell this block anything the
 * other cannot — what is under test is the block's own answer.
 */
function MountedBlock({ editor: instance }: { editor: Editor }) {
  const [open, setOpen] = useState(true);

  return (
    <EditorMenu
      editor={instance}
      id="formatting-menu"
      open={open}
      onOpenChange={setOpen}
      at={{ x: 0, y: 0 }}
    >
      <ClipboardMenuItems editor={instance} closeMenu={() => setOpen(false)} />
    </EditorMenu>
  );
}

/** One flavour on the clipboard, in the shape `ClipboardItem` presents it. */
function heldText(text: string) {
  return [{ types: ["text/plain"], getType: async () => ({ text: async () => text }) }];
}

function row(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((item) =>
    item.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`no menu row for ${label}`);
  return found;
}

function menuIsOpen(): boolean {
  return document.querySelector("[role='menu']") !== null;
}

/** Press a row the way a writer does, and let the verb settle. */
async function pressRow(label: string): Promise<void> {
  await act(async () => row(label).click());
}

/** Reach the row, which is what a tooltip waits for. */
async function focusRow(label: string): Promise<void> {
  await act(async () => row(label).focus());
}

describe("a clipboard verb the browser refuses", () => {
  let fixture: ReactEditorFixture | null = null;

  /** A clipboard with only the parts the case cares about, as a browser exposes it. */
  async function openMenuOver(clipboard: Partial<Clipboard>): Promise<Editor> {
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
    fixture = createReactEditorFixture({ content: "<p>He had rehearsed this</p>" });
    await fixture.render(<MountedBlock editor={fixture.editor} />);
    return fixture.editor;
  }

  afterEach(() => {
    fixture?.destroy();
    fixture = null;
  });

  it("keeps the menu open and greys Paste where the read is refused", async () => {
    const instance = await openMenuOver({
      read: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      writeText: vi.fn(),
    });

    await pressRow("Paste");

    // The refusal is drawn where the writer pressed, which takes a row still
    // standing there to draw it on.
    expect(menuIsOpen()).toBe(true);
    expect(row("Paste").getAttribute("aria-disabled")).toBe("true");
    expect(instance.getText()).toBe("He had rehearsed this");
  });

  it("says why the writer cannot paste, on the row they are standing on", async () => {
    await openMenuOver({
      read: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      writeText: vi.fn(),
    });

    await pressRow("Paste");
    await focusRow("Paste");

    expect(document.querySelector("[role='tooltip']")?.textContent).toContain(
      "will not hand the clipboard to the page",
    );
  });

  it("greys Cut with Copy when the write is refused, and leaves Paste offered", async () => {
    const instance = await openMenuOver({
      read: vi.fn(),
      writeText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
    });
    instance.commands.selectAll();

    await pressRow("Copy");

    expect(menuIsOpen()).toBe(true);
    // One refusal answers for both write verbs: a Cut whose copy was refused
    // would take the writer's words with nothing to paste back.
    expect(row("Copy").getAttribute("aria-disabled")).toBe("true");
    expect(row("Cut").getAttribute("aria-disabled")).toBe("true");
    expect(row("Paste").getAttribute("aria-disabled")).toBeNull();
  });

  it("closes on a copy the clipboard took", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const instance = await openMenuOver({
      read: vi.fn().mockResolvedValue(heldText("held")),
      writeText,
    });
    instance.commands.selectAll();

    await pressRow("Copy");

    expect(writeText).toHaveBeenCalled();
    // Nothing to say, so the menu gets out of the writer's way.
    expect(menuIsOpen()).toBe(false);
  });
});
