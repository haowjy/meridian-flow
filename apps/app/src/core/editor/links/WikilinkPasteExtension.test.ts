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

it("links a pasted Markdown note, leaving code and embeds as text", () => {
  const target = editor(DOCUMENTS);
  paste(target, {
    "text/plain": [
      "- [[Lin Feng]] waits.",
      "- See [[chapter-1|the opening]].",
      "- [[Kael]] has no page yet.",
      "- The [[Jade Gate]] opens.",
      "- ![[map.png]]",
      "- Inline `[[code]]` stays.",
    ].join("\n"),
  });
  expect(links(target)).toEqual([
    ["Lin Feng", "kb://characters/Lin Feng.md"],
    ["the opening", "chapter-1.md"],
    ["Kael", "Kael.md"],
    ["Jade Gate", "Jade Gate.md"],
  ]);
  // The Markdown door parsed it: a list, with the code span as code.
  expect(target.state.doc.textContent).not.toContain("- ");
  expect(target.state.doc.textContent).toContain("![[map.png]]");
  expect(target.state.doc.textContent).toContain("[[code]]");
});

it("links plain prose that the Markdown door hands to the default paste", () => {
  const target = editor(DOCUMENTS);
  paste(target, { "text/plain": "Lin met [[lin feng#Past]] at [[Arc 1/Kael|the duel]]." });
  expect(links(target)).toEqual([
    ["lin feng", "kb://characters/Lin Feng.md#Past"],
    ["the duel", "../Arc 1/Kael.md"],
  ]);
});

it("links the literal brackets in pasted HTML", () => {
  const target = editor(DOCUMENTS);
  paste(target, { "text/html": "<p>Lin met <strong>[[Lin Feng]]</strong>.</p>" });
  expect(links(target)).toEqual([["Lin Feng", "kb://characters/Lin Feng.md"]]);
});

it("leaves the brackets as text while the documents are still loading", () => {
  const target = editor(null);
  paste(target, { "text/plain": "Lin met [[Lin Feng]]." });
  expect(links(target)).toEqual([]);
  expect(target.state.doc.textContent).toBe("Lin met [[Lin Feng]].");
});

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

it("keeps an escaped link as literal brackets, through the Markdown door and plain prose", () => {
  const list = editor(DOCUMENTS);
  paste(list, { "text/plain": "- one \\[[Lin Feng]]\n- two `\\[[code]]`" });
  expect(links(list)).toEqual([]);
  expect(list.state.doc.textContent).toBe("one [[Lin Feng]]two \\[[code]]");

  const prose = editor(DOCUMENTS);
  paste(prose, { "text/plain": "Meridian writes \\[\\[Lin Feng]] and ![[map.png]]." });
  expect(links(prose)).toEqual([]);
  expect(prose.state.doc.textContent).toBe("Meridian writes [[Lin Feng]] and ![[map.png]].");
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

it("leaves text dragged within the document as written", () => {
  const target = editor(DOCUMENTS, "<p>[[Lin Feng]] waits.</p>");
  const slice = target.state.doc.slice(1, 13);
  expect(slice.content.textBetween(0, slice.content.size)).toBe("[[Lin Feng]]");
  target.view.dragging = { slice, move: false } as typeof target.view.dragging;
  drop(target, target.state.doc.content.size - 1, { "text/plain": "[[Lin Feng]]" });
  expect(links(target)).toEqual([]);
  expect(target.state.doc.textContent).toBe("[[Lin Feng]] waits.[[Lin Feng]]");
});

it("links a paste into a table cell", () => {
  const target = editor(DOCUMENTS, "<table><tr><td><p>x</p></td></tr></table>");
  let inCell = 0;
  target.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph") inCell = pos + 1 + node.content.size;
  });
  target.commands.setTextSelection(inCell);
  paste(target, { "text/plain": "see [[Lin Feng]]" });
  expect(links(target)).toEqual([["Lin Feng", "kb://characters/Lin Feng.md"]]);
  expect(target.state.doc.textContent).toBe("xsee Lin Feng");
});
