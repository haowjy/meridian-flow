/** Stored-link extraction and substitution contracts, independent of DB orchestration. */
import { expect, it } from "vitest";
import * as Y from "yjs";
import * as links from "./document-link-occurrences.js";

function seed(paragraphs: readonly (readonly [string, string, Record<string, unknown>?][])[]) {
  const doc = new Y.Doc({ gc: false });
  const fragment = doc.getXmlFragment("prosemirror");
  for (const runs of paragraphs) {
    const p = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    fragment.push([p]);
    p.push([text]);
    for (const [words, href, marks] of runs)
      text.insert(text.length, words, { link: { href, title: "keep" }, ...marks });
  }
  return { doc, fragment };
}
const words = (fragment: Y.XmlFragment) =>
  links
    .extractDocumentLinkOccurrences(fragment)
    .filter((o) => o.kind === "text")
    .map((o) => [o.href, o.words]);

it("groups marks but not paragraphs, rewrites chains once and touches only literal src", () => {
  const { doc, fragment } = seed([
    [
      ["fi", "five.md", { strong: {} }],
      ["ve", "five.md", { em: {} }],
    ],
    [["six", "six.md"]],
    [["fi", "five.md"]],
    [["ve", "five.md"]],
  ]);
  const media = ["image", "figure"].map((kind) => {
    const node = new Y.XmlElement(kind);
    node.setAttribute("src", "five.md");
    node.setAttribute("alt", "five.md");
    return node;
  });
  const external = new Y.XmlElement("image");
  external.setAttribute("src", "https://example.com/image.png");
  fragment.push([...media, external]);
  const substitutions = new Map([
    ["five.md", { href: "six.md", oldFilename: "five.md", newFilename: "six.md" }],
    ["six.md", { href: "seven.md", oldFilename: "six.md", newFilename: "seven.md" }],
  ]);
  expect(links.applyDocumentLinkSubstitutions(fragment, substitutions)).toBe(6);
  expect(words(fragment)).toEqual([
    ["six.md", "six"],
    ["seven.md", "seven"],
    ["six.md", "fi"],
    ["six.md", "ve"],
  ]);
  expect(media.map((n) => [n.getAttribute("src"), n.getAttribute("alt")])).toEqual([
    ["six.md", "five.md"],
    ["six.md", "five.md"],
  ]);
  expect(external.getAttribute("src")).toBe("https://example.com/image.png");
  doc.destroy();
});
