/** Stored-link extraction and substitution contracts, independent of DB orchestration. */
import { expect, it } from "vitest";
import * as Y from "yjs";
import { applyDocumentLinkSubstitutions, extractDocumentLinkOccurrences } from "../index.js";

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
  extractDocumentLinkOccurrences(fragment)
    .filter((o) => o.kind === "text")
    .map((o) => [o.href, o.words]);

it.each([
  ["chapter.md", "gate.md", true],
  ["chapter", "gate", true],
  ["chapter", "chapter", false],
  ["chapter ", "chapter ", true],
])("relabels exact filename words, never custom words %s", (before, after, relabel) => {
  const { doc, fragment } = seed([
    [
      [before.slice(0, 1), "chapter.md", { strong: {} }],
      [before.slice(1), "chapter.md", { em: {} }],
    ],
  ]);
  expect(
    applyDocumentLinkSubstitutions(
      fragment,
      new Map([
        [
          "chapter.md",
          {
            href: "gate.md",
            ...(relabel ? { oldFilename: "chapter.md", newFilename: "gate.md" } : {}),
          },
        ],
      ]),
    ),
  ).toBe(1);
  expect(words(fragment)).toEqual([["gate.md", after]]);
  const occurrence = extractDocumentLinkOccurrences(fragment)[0];
  if (occurrence?.kind !== "text") throw new Error("Missing text occurrence");
  expect(occurrence.runs[0]?.attributes).toMatchObject({ strong: {}, link: { title: "keep" } });
  if (!relabel) expect(occurrence.runs[1]?.attributes.em).toEqual({});
  doc.destroy();
});

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
  expect(applyDocumentLinkSubstitutions(fragment, substitutions)).toBe(6);
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
