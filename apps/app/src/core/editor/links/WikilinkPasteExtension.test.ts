// @vitest-environment jsdom
/**
 * A pasted Obsidian note's `[[Name]]` arrives as standard links through the
 * Editor's real paste path, whichever door the clipboard text takes: Markdown
 * with structure, or plain prose.
 */
import { Editor } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import { linkAheadAddress } from "./link-address";
import type { WikilinkPasteCatalog } from "./wikilink-paste";

const HOLDER = "manuscript://volume-1/chapter-2.md";
const DOCUMENTS = [
  HOLDER,
  "manuscript://volume-1/chapter-1.md",
  "manuscript://volume-1/Jade Gate.md",
  "kb://places/Jade Gate.md",
  "kb://characters/Lin Feng.md",
];

const live: Editor[] = [];
afterEach(() => {
  for (const editor of live.splice(0)) editor.destroy();
});

/** An Editor whose link index holds `targets`, or is still loading (null). */
function editor(targets: readonly string[] | null, content = "<p></p>"): Editor {
  const catalog: WikilinkPasteCatalog | null = targets && {
    holderUri: HOLDER,
    targets,
    linkAhead: (name, folders) => {
      const uri = linkAheadAddress(HOLDER, name, folders);
      return uri && !DOCUMENTS.includes(uri) ? { uri } : null;
    },
  };
  const created = new Editor({
    extensions: createStandaloneEditorExtensions({ wikilinkPaste: { catalog: () => catalog } }),
    content,
  });
  live.push(created);
  return created;
}

function links(target: Editor): [string, string][] {
  const out: [string, string][] = [];
  target.state.doc.descendants((node) => {
    const mark = node.marks.find((candidate) => candidate.type.name === "link");
    if (mark && node.text) out.push([node.text, mark.attrs.href]);
  });
  return out;
}

/**
 * The browser's paste: a paste event on the editor, carrying clipboard data,
 * through ProseMirror's own handler and every plugin's paste props. jsdom has
 * no ClipboardEvent, so the data rides on a plain event.
 */
function paste(target: Editor, data: Record<string, string>) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { types: Object.keys(data), getData: (type: string) => data[type] ?? "" },
  });
  target.view.dom.dispatchEvent(event);
}

it("keeps the characters when pasted into a code block", () => {
  const target = editor(DOCUMENTS, "<pre><code>x</code></pre>");
  target.commands.setTextSelection(2);
  paste(target, { "text/plain": "see [[Lin Feng]] here" });
  expect(links(target)).toEqual([]);
  expect(target.state.doc.textContent).toBe("xsee [[Lin Feng]] here");
});

/**
 * The browser's drop from outside the editor, landing at `pos`. jsdom has no
 * layout, so the pointer's position is stubbed where ProseMirror (and the
 * paste policy) ask for it.
 */
function drop(target: Editor, pos: number, data: Record<string, string>) {
  target.view.posAtCoords = () => ({ pos, inside: -1 });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: Object.keys(data), files: [], getData: (type: string) => data[type] ?? "" },
  });
  target.view.dom.dispatchEvent(event);
}

it("keeps the characters when dropped into a code block, and links them dropped into prose", () => {
  const fence = editor(DOCUMENTS, "<pre><code>x</code></pre>");
  drop(fence, 2, { "text/plain": "see [[Lin Feng]] here" });
  expect(links(fence)).toEqual([]);
  expect(fence.state.doc.textContent).toContain("see [[Lin Feng]] here");

  const prose = editor(DOCUMENTS, "<p>x</p>");
  drop(prose, 2, { "text/plain": "see [[Lin Feng]] here" });
  expect(links(prose)).toEqual([["Lin Feng", "kb://characters/Lin Feng.md"]]);
});

it("gives paste without formatting the characters, while an ordinary paste links", () => {
  const plain = editor(DOCUMENTS);
  // ProseMirror reads Shift from the last keydown, as the browser's
  // Ctrl/Cmd+Shift+V leaves it.
  plain.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }));
  paste(plain, { "text/plain": "Lin met [[Lin Feng]]." });
  expect(links(plain)).toEqual([]);
  expect(plain.state.doc.textContent).toBe("Lin met [[Lin Feng]].");

  const ordinary = editor(DOCUMENTS);
  paste(ordinary, { "text/plain": "Lin met [[Lin Feng]]." });
  expect(links(ordinary)).toEqual([["Lin Feng", "kb://characters/Lin Feng.md"]]);
});

const menuPaste = () => new Event("paste") as ClipboardEvent;

it("keeps the characters of an HTML-only clipboard pasted into code, by key or from the menu", () => {
  const keyed = editor(DOCUMENTS, "<pre><code>x</code></pre>");
  keyed.commands.setTextSelection(2);
  paste(keyed, { "text/html": "<p>see [[Lin Feng]] here</p>" });
  expect(links(keyed)).toEqual([]);
  expect(keyed.state.doc.textContent).toContain("see [[Lin Feng]] here");

  // The menu's Paste has no clipboard event: it calls pasteHTML on the view
  // (`clipboard-commands.ts`). The event passed here only stands in for the
  // one ProseMirror would construct, which jsdom cannot.
  const menu = editor(DOCUMENTS, "<pre><code>x</code></pre>");
  menu.commands.setTextSelection(2);
  menu.view.pasteHTML("<p>see [[Lin Feng]] here</p>", menuPaste());
  expect(links(menu)).toEqual([]);
  expect(menu.state.doc.textContent).toContain("see [[Lin Feng]] here");
});
