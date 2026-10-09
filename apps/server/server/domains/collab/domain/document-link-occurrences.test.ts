/** Stored-link extraction and substitution contracts, independent of DB orchestration. */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import { updateYFragment } from "y-prosemirror";
import * as Y from "yjs";
import * as links from "./document-link-occurrences.js";

function seed(
  paragraphs: readonly (readonly [string, string | null, Record<string, unknown>?][])[],
) {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 100;
  const fragment = doc.getXmlFragment("prosemirror");
  for (const runs of paragraphs) {
    const p = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    fragment.push([p]);
    p.push([text]);
    for (const [words, href, marks] of runs)
      text.insert(text.length, words, {
        ...(href === null ? {} : { link: { href, title: "keep" } }),
        ...marks,
      });
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

// The first move leaves formatting history that a later PM write normalizes.
it.each([
  { edit: "adjacent prose", block: 0, label: "Target", prose: " returns." },
  { edit: "link label", block: 0, label: "Tar drafted get", prose: " waits." },
  { edit: "another paragraph", block: 1, label: "Target", prose: " waits." },
])("keeps old hrefs off plain draft text after editing $edit", ({ block, label, prose }) => {
  const { doc, fragment } = seed([[["Target", "target.md"]], [["Other paragraph.", null]]]);
  const text = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  text.insert(text.length, " waits.", {});
  const draft = new Y.Doc({ gc: false });
  draft.clientID = 200;
  Y.applyUpdate(draft, Y.encodeStateAsUpdate(doc));
  rewrite(doc, "target.md", "final.md", 300);
  Y.applyUpdate(draft, Y.encodeStateAsUpdate(doc));
  const schema = buildDocumentSchema();
  const paragraph = schema.nodes.paragraph.create(
    null,
    block === 0
      ? [
          schema.text(label, [schema.marks.link.create({ href: "final.md", title: "keep" })]),
          schema.text(prose),
        ]
      : schema.text("Drafted paragraph."),
  );
  updateYFragment(
    draft,
    draft.getXmlFragment("prosemirror").get(block) as Y.XmlFragment,
    paragraph,
    { mapping: new Map(), isOMark: new Map() },
  );
  rewrite(doc, "final.md", "merged.md", 400);
  Y.applyUpdate(draft, Y.encodeStateAsUpdate(doc));
  const draftText = (draft.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(
    0,
  ) as Y.XmlText;
  expect(draftText.toDelta()).toEqual([
    { insert: label, attributes: { link: { href: "merged.md", title: "keep" } } },
    { insert: prose },
  ]);
  expect(text.toDelta()).toEqual([
    { insert: "Target", attributes: { link: { href: "merged.md", title: "keep" } } },
    { insert: " waits." },
  ]);
  draft.destroy();
  doc.destroy();
});

function rewrite(doc: Y.Doc, from: string, to: string, clientID: number) {
  const clone = new Y.Doc({ gc: false });
  clone.clientID = clientID;
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  links.applyDocumentLinkSubstitutions(
    clone.getXmlFragment("prosemirror"),
    new Map([[from, { href: to }]]),
  );
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(clone, Y.encodeStateVector(doc)));
  clone.destroy();
}
