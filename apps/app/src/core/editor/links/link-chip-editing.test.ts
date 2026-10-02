// @vitest-environment jsdom
/**
 * Drawing an internal link as a chip must not change editing it (spec
 * decision 6): the label stays ordinary marked text, one `<a>` wraps it
 * whatever formatting is inside, and nothing about the chip reaches the
 * document, the clipboard, or another peer.
 */

import type { ResolvedDocumentLink } from "@meridian/contracts/protocol";
import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type CollabPair, createCollabPair } from "@/test-support/collab-editors";

import { getLinkResolution } from "./LinkSurfaceExtension";

const LIN_FENG: ResolvedDocumentLink = {
  documentId: "doc-lin-feng",
  title: "Lin Feng",
  scheme: "kb",
  path: "characters/Lin Feng.md",
  uri: "kb://characters/Lin Feng.md",
  workId: null,
};

const LINK = { type: "link", attrs: { href: "../cast/Lin Feng.md" } };

/** `Ask Lin **Feng** now.` with the link around `Lin Feng`. */
const MIXED = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Ask " },
        { type: "text", text: "Lin ", marks: [LINK] },
        { type: "text", text: "Feng", marks: [LINK, { type: "strong" }] },
        { type: "text", text: " now." },
      ],
    },
  ],
};

const pairs: CollabPair[] = [];

afterEach(() => {
  for (const pair of pairs.splice(0)) pair.destroy();
});

/** The document as stored, before anything was drawn on it. */
let stored: unknown;

async function drawn(): Promise<Editor> {
  const pair = createCollabPair(MIXED);
  pairs.push(pair);
  const editor = pair.local;
  stored = editor.getJSON();
  // Setting the content is not the writer's edit; undo stops at it.
  yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
  getLinkResolution(editor)?.registerResolver(async () => LIN_FENG);
  await vi.waitFor(() =>
    expect(editor.view.dom.querySelector('[data-link-state="resolved"]')).not.toBeNull(),
  );
  return editor;
}

/** Type the way a browser reports composition-free input. */
function type(editor: Editor, text: string) {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const insert = () => editor.state.tr.insertText(character, from, to);
    const handled = editor.view.someProp("handleTextInput", (handle) =>
      handle(editor.view, from, to, character, insert),
    );
    if (!handled) editor.view.dispatch(insert());
  }
}

/** The text the link mark covers, in document order. */
function linkedText(editor: Editor): string {
  let text = "";
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === "link")) text += node.text;
  });
  return text;
}

/** Document position just before the first character of `needle`. */
function positionOf(editor: Editor, needle: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(needle)) {
      found = pos + (node.text.indexOf(needle) ?? 0);
    }
  });
  if (found < 0) throw new Error(`no ${needle}`);
  return found;
}

describe("an internal link drawn as a chip", () => {
  it("is one anchor around a label with formatting inside it", async () => {
    const editor = await drawn();

    const anchors = editor.view.dom.querySelectorAll("a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.textContent).toBe("Lin Feng");
    expect(anchors[0]?.querySelector("strong")?.textContent).toBe("Feng");
    // Each text node carries the same part, so the anchor reads one chip.
    const parts = [...(anchors[0]?.querySelectorAll("[data-link-chip-part]") ?? [])];
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.getAttribute("data-link-chip-part")).toBe("filled");
      expect(part.getAttribute("data-link-chip-icon")).toBe("kb");
    }
  });

  it("puts nothing about the chip into the document", async () => {
    const editor = await drawn();

    expect(editor.getJSON()).toEqual(stored);
    expect(JSON.stringify(stored)).not.toMatch(/chip|link-state|resolved/);
  });

  it("lets typing inside the label edit it", async () => {
    const editor = await drawn();
    editor.commands.setTextSelection(positionOf(editor, "Feng"));

    type(editor, "X");

    expect(linkedText(editor)).toBe("Lin XFeng");
  });

  it("does not extend the link from either edge", async () => {
    const editor = await drawn();
    editor.commands.setTextSelection(positionOf(editor, "Lin "));
    type(editor, "<");
    editor.commands.setTextSelection(positionOf(editor, " now."));
    type(editor, ">");

    expect(editor.state.doc.textContent).toBe("Ask <Lin Feng> now.");
    expect(linkedText(editor)).toBe("Lin Feng");
  });

  it("undoes and redoes an edit inside the label", async () => {
    const editor = await drawn();
    editor.commands.setTextSelection(positionOf(editor, "Feng"));
    type(editor, "X");

    expect(editor.commands.undo()).toBe(true);
    expect(linkedText(editor)).toBe("Lin Feng");
    expect(editor.commands.redo()).toBe(true);
    expect(linkedText(editor)).toBe("Lin XFeng");
  });

  it("copies as the link's own spelling and pastes back as the same link", async () => {
    const editor = await drawn();
    const from = positionOf(editor, "Ask ");
    const to = positionOf(editor, " now.");
    const { dom, text } = editor.view.serializeForClipboard(editor.state.doc.slice(from, to));

    expect(dom.querySelector("[data-link-chip-part], [data-link-state]")).toBeNull();
    // Plain text is Markdown: the label keeps its formatting, the target its spelling.
    expect(text).toBe("Ask [Lin **Feng**](<../cast/Lin Feng.md>)");

    const pair = createCollabPair({ type: "doc", content: [{ type: "paragraph" }] });
    pairs.push(pair);
    const target = pair.local;
    // jsdom has no ClipboardEvent; the paste path only reads its type.
    target.view.pasteHTML(dom.innerHTML, new Event("paste") as ClipboardEvent);

    expect(linkedText(target)).toBe("Lin Feng");
    const marks = new Set<string>();
    target.state.doc.descendants((node) => {
      for (const mark of node.marks) if (mark.type.name === "link") marks.add(mark.attrs.href);
    });
    expect([...marks]).toEqual(["../cast/Lin Feng.md"]);
  });
});
