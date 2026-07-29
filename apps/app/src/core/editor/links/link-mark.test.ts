// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../config";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function editorWith(content: string): Editor {
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content });
  return editor;
}

function hrefsIn(target: Editor): string[] {
  const hrefs: string[] = [];
  target.state.doc.descendants((node) => {
    const mark = node.marks.find((candidate) => candidate.type.name === "link");
    if (mark) hrefs.push(String(mark.attrs.href));
  });
  return hrefs;
}

/**
 * TipTap's stock link fence is an allow-list of web schemes, which reads every
 * internal spelling as an attack: it drops the mark on parse and refuses every
 * command. These are the cases that regression protects.
 */
describe("the link mark carries the whole internal family", () => {
  it.each([
    ["[[The Second Gate]]", "wikilink"],
    ["manuscript://appendix/vault-charter", "scheme"],
    ["work://a1b2/notes.md", "scheme"],
    ["chapter-213.md", "relative"],
    ["https://example.com", "external"],
  ])("keeps %s on parse and renders it as %s", (href, kind) => {
    const target = editorWith(`<p><a href="${href}">linked</a></p>`);

    expect(hrefsIn(target)).toEqual([href]);
    expect(target.view.dom.querySelector("a")?.getAttribute("data-link-kind")).toBe(kind);
  });

  it.each([
    "[[The Second Gate]]",
    "manuscript://appendix/vault-charter",
    "chapter-213.md",
    "https://example.com",
  ])("accepts %s from a link command", (href) => {
    const target = editorWith("<p>hello world</p>");
    target.commands.setTextSelection({ from: 1, to: 6 });

    expect(target.commands.setLink({ href, title: null })).toBe(true);
    expect(hrefsIn(target)).toEqual([href]);
  });

  it("refuses a script URL on the way in and renders no destination for one that got in", () => {
    const parsed = editorWith('<p><a href="javascript:alert(1)">linked</a></p>');
    expect(hrefsIn(parsed)).toEqual([]);

    parsed.commands.setTextSelection({ from: 1, to: 4 });
    expect(parsed.commands.setLink({ href: "javascript:alert(1)", title: null })).toBe(false);

    // The markdown parser is a third door into the document, so the renderer
    // holds the same fence rather than trusting what reached the mark.
    parsed.commands.setTextSelection({ from: 1, to: 4 });
    parsed.view.dispatch(
      parsed.state.tr.addMark(
        1,
        4,
        parsed.state.schema.marks.link.create({ href: "javascript:alert(1)", title: null }),
      ),
    );
    expect(parsed.view.dom.querySelector("a")?.getAttribute("href")).toBe("");
  });
});

describe("bare-URL autolink", () => {
  it("links a hostname the writer typed", () => {
    const target = editorWith("<p></p>");
    target.commands.setTextSelection(1);
    target.commands.insertContent("see example.com ");

    expect(hrefsIn(target)).toEqual(["https://example.com"]);
  });

  it("leaves a relative document path alone", () => {
    // `.md` is a real TLD, so linkify reads `chapter-213.md` as a site and
    // would rewrite a project document into an external link.
    const target = editorWith("<p></p>");
    target.commands.setTextSelection(1);
    target.commands.insertContent("see chapter-213.md ");

    expect(hrefsIn(target)).toEqual([]);
  });
});
