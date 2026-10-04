/** Stored link traversal and rich-text merge contracts from the L4 relabel probe. */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { applyDocumentLinkSubstitutions, extractDocumentLinkOccurrences } from "../index.js";

const schema = buildDocumentSchema();
const oldHref = "chapter-1.md";
const newHref = "../volume-2/the-gate.md";
const link = (href = oldHref, title: string | null = null) => schema.mark("link", { href, title });
const substitutions = new Map([
  [oldHref, { href: newHref, oldFilename: oldHref, newFilename: "the-gate.md" }],
]);
const fragment = (doc: Y.Doc) => doc.getXmlFragment("prosemirror");
function seed() {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 5000;
  prosemirrorToYXmlFragment(
    schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("Start "),
        schema.text(oldHref, [link()]),
        schema.text(" then "),
        schema.text("chapter-1", [schema.mark("strong"), link()]),
        schema.text(" and "),
        schema.text("the elder", [link()]),
        schema.text("."),
      ]),
      schema.node("paragraph", null, [
        schema.text("Mixed "),
        schema.text("chap", [link()]),
        schema.text("ter-1", [schema.mark("em"), link()]),
        schema.text(" end."),
      ]),
    ]),
    fragment(doc),
  );
  return doc;
}
const view = (doc: Y.Doc) => yXmlFragmentToProseMirrorRootNode(fragment(doc), schema).toJSON();
const textOccurrences = (doc: Y.Doc) =>
  extractDocumentLinkOccurrences(fragment(doc)).filter((o) => o.kind === "text");

function requiredOccurrence(doc: Y.Doc, index: number) {
  const occurrence = textOccurrences(doc)[index];
  const first = occurrence?.runs[0];
  if (!occurrence || !first) throw new Error(`Missing fixture occurrence ${index}`);
  return { ...occurrence, first };
}

it("extracts contiguous words across marks and preserves custom words and first-character marks", () => {
  const doc = seed();
  expect(textOccurrences(doc).map((o) => [o.href, o.words, o.runs.length])).toEqual([
    [oldHref, oldHref, 1],
    [oldHref, "chapter-1", 1],
    [oldHref, "the elder", 1],
    [oldHref, "chapter-1", 2],
  ]);
  expect(applyDocumentLinkSubstitutions(fragment(doc), substitutions)).toBe(4);
  expect(textOccurrences(doc).map((o) => [o.href, o.words])).toEqual([
    [newHref, "the-gate.md"],
    [newHref, "the-gate"],
    [newHref, "the elder"],
    [newHref, "the-gate"],
  ]);
  expect(textOccurrences(doc)[1]?.runs[0]?.attributes.strong).toEqual({});
  expect(textOccurrences(doc)[3]?.runs[0]?.attributes.em).toBeUndefined();
  expect(applyDocumentLinkSubstitutions(fragment(doc), substitutions)).toBe(0);
  doc.destroy();
});

it.each([
  ["quiet", null],
  [
    "typing inside",
    (doc: Y.Doc) => {
      const o = requiredOccurrence(doc, 0);
      o.text.insert(o.first.start + 7, "X", o.first.attributes);
    },
  ],
  [
    "hand retarget",
    (doc: Y.Doc) => {
      const o = requiredOccurrence(doc, 1);
      o.text.format(o.first.start, o.words.length, {
        link: { href: "kb://elsewhere.md", title: null },
      });
    },
  ],
  [
    "delete link",
    (doc: Y.Doc) => {
      const o = requiredOccurrence(doc, 0);
      o.text.delete(o.first.start, o.words.length);
    },
  ],
  [
    "delete surrounding words",
    (doc: Y.Doc) => {
      const o = requiredOccurrence(doc, 0);
      o.text.delete(o.first.start - 1, o.words.length + 2);
    },
  ],
  [
    "typing after",
    (doc: Y.Doc) => {
      const o = requiredOccurrence(doc, 0);
      o.text.insert(o.first.start + o.words.length, "!", {});
    },
  ],
  [
    "typing before",
    (doc: Y.Doc) => {
      const o = requiredOccurrence(doc, 0);
      o.text.insert(o.first.start, "~", {});
    },
  ],
  [
    "bold",
    (doc: Y.Doc) => {
      const o = requiredOccurrence(doc, 0);
      o.text.format(o.first.start, o.words.length, { strong: {} });
    },
  ],
] as const)("merges the probe scenario: %s", (scenario, editPeer) => {
  const source = seed();
  const snapshot = new Y.Doc({ gc: false });
  snapshot.clientID = 6000;
  const peer = new Y.Doc({ gc: false });
  peer.clientID = 7000;
  const state = Y.encodeStateAsUpdate(source);
  Y.applyUpdate(snapshot, state);
  Y.applyUpdate(peer, state);
  const vector = Y.encodeStateVector(source);
  applyDocumentLinkSubstitutions(fragment(snapshot), substitutions);
  // Production's caller must persist this diff before publishing to source.
  expect(textOccurrences(source)[0]?.words).toBe(oldHref);
  editPeer?.(peer);
  const peerUpdate = Y.encodeStateAsUpdate(peer, vector);
  const rewriteUpdate = Y.encodeStateAsUpdate(snapshot, vector);
  Y.applyUpdate(snapshot, peerUpdate);
  Y.applyUpdate(peer, rewriteUpdate);
  expect(view(snapshot)).toEqual(view(peer));
  const occurrences = textOccurrences(snapshot);
  if (scenario === "typing inside") expect(occurrences[0]?.words).toBe("the-gate.mdX");
  if (scenario === "hand retarget") expect(occurrences[1]?.href).toBe("kb://elsewhere.md");
  if (scenario === "bold") expect(occurrences[0]?.runs[0]?.attributes.strong).toEqual({});
  if (scenario === "typing after") expect(JSON.stringify(view(snapshot))).toContain("!");
  if (scenario === "typing before") expect(occurrences[0]?.words).toContain("~");
  if (scenario.startsWith("delete")) {
    // Accepted Yjs anomaly: replacement survives and the old href leaks into
    // adjacent words under a concurrent delete, exactly as the settled probe.
    expect(occurrences[0]?.words).toBe("the-gate.md");
    expect(occurrences[1]?.href).toBe(oldHref);
    expect(occurrences[1]?.words).toBe(scenario === "delete link" ? " then " : "then ");
  }
  source.destroy();
  snapshot.destroy();
  peer.destroy();
});

it("rewrites chains simultaneously, self links, split paragraphs, and literal image src only", () => {
  const doc = new Y.Doc();
  prosemirrorToYXmlFragment(
    schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("five", [link("./five.md", "first")])]),
      schema.node("paragraph", null, [schema.text("six", [link("six.md")])]),
      schema.node("paragraph", null, [schema.text("split", [link("./five.md")])]),
    ]),
    fragment(doc),
  );
  const image = new Y.XmlElement("image");
  image.setAttribute("src", "./five.md");
  image.setAttribute("alt", "five.md");
  const asset = new Y.XmlElement("figure");
  asset.setAttribute("src", "https://example.com/picture.png");
  const imageParagraph = new Y.XmlElement("paragraph");
  imageParagraph.push([image]);
  fragment(doc).push([imageParagraph, asset]);
  expect(
    applyDocumentLinkSubstitutions(
      fragment(doc),
      new Map([
        ["./five.md", { href: "six.md", oldFilename: "five.md", newFilename: "six.md" }],
        ["six.md", { href: "seven.md", oldFilename: "six.md", newFilename: "seven.md" }],
      ]),
    ),
  ).toBe(4);
  expect(textOccurrences(doc).map((o) => [o.href, o.words])).toEqual([
    ["six.md", "six"],
    ["seven.md", "seven"],
    ["six.md", "split"],
  ]);
  expect(textOccurrences(doc)[0]?.runs[0]?.attributes.link.title).toBe("first");
  expect(image.getAttribute("src")).toBe("six.md");
  expect(image.getAttribute("alt")).toBe("five.md");
  expect(asset.getAttribute("src")).toBe("https://example.com/picture.png");
  doc.destroy();
});

it.each([
  "Chapter-1",
  "chapter-1 ",
  "my chapter-1",
  "[[chapter-1]]",
])("retargets but does not relabel custom words %s", (words) => {
  const doc = new Y.Doc();
  prosemirrorToYXmlFragment(
    schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text(words, [link(oldHref, "keep")])]),
    ]),
    fragment(doc),
  );
  applyDocumentLinkSubstitutions(fragment(doc), substitutions);
  expect(
    textOccurrences(doc).map((o) => [o.href, o.words, o.runs[0]?.attributes.link.title]),
  ).toEqual([[newHref, words, "keep"]]);
  doc.destroy();
});

it("treats a label split across paragraphs as two occurrences, not one relabel", () => {
  const doc = new Y.Doc();
  prosemirrorToYXmlFragment(
    schema.node("doc", null, [
      schema.node("blockquote", null, [
        schema.node("paragraph", null, [schema.text("chap", [link()])]),
        schema.node("paragraph", null, [schema.text("ter-1", [link()])]),
      ]),
      schema.node("paragraph", null, [schema.text("[[chapter-1]]")]),
    ]),
    fragment(doc),
  );
  expect(applyDocumentLinkSubstitutions(fragment(doc), substitutions)).toBe(2);
  expect(textOccurrences(doc).map((o) => [o.href, o.words])).toEqual([
    [newHref, "chap"],
    [newHref, "ter-1"],
  ]);
  doc.destroy();
});

it("retarget-only preserves every run's marks and title", () => {
  const doc = seed();
  applyDocumentLinkSubstitutions(fragment(doc), new Map([[oldHref, { href: newHref }]]));
  expect(textOccurrences(doc).map((o) => o.words)).toEqual([
    oldHref,
    "chapter-1",
    "the elder",
    "chapter-1",
  ]);
  const mixed = textOccurrences(doc)[3];
  expect(mixed?.runs.length).toBe(2);
  expect(mixed?.runs[1]?.attributes.em).toEqual({});
  expect(mixed?.runs.every((run) => run.attributes.link.href === newHref)).toBe(true);
  doc.destroy();
});
