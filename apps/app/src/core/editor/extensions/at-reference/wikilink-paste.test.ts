// @vitest-environment jsdom
/**
 * A pasted Obsidian note's `[[Name]]` arrives as standard links through the
 * Editor's real paste path, whichever door the clipboard text takes: Markdown
 * with structure, or plain prose.
 */
import { Editor } from "@tiptap/core";
import { afterEach, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../../config";
import { linkAheadAddress } from "../../links/link-address";
import type { AtReferenceCatalog } from "./AtReferenceExtension";

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

function editor(targets: readonly string[] | null): Editor {
  const catalog = {
    holderUri: HOLDER,
    linkAhead: (name: string, folders?: readonly string[]) => {
      const uri = linkAheadAddress(HOLDER, name, folders);
      return uri && !DOCUMENTS.includes(uri) ? { uri } : null;
    },
    linkTargets: () => targets,
  } as unknown as AtReferenceCatalog;
  const created = new Editor({
    extensions: createStandaloneEditorExtensions({ atReferences: { catalog: () => catalog } }),
    content: "<p></p>",
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
