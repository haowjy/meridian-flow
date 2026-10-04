/** Pure paste contracts: syntax and deterministic Obsidian-order target choice. */
import { Schema, Slice } from "@tiptap/pm/model";
import { expect, it } from "vitest";
import { linkAheadAddress } from "./link-address";
import { linkPastedWikilinks } from "./wikilink-paste";

const schema = new Schema({
  nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} },
  marks: { link: { attrs: { href: {} } }, code: {} },
});
const HOLDER = "manuscript://volume-1/chapter-2.md";

function paste(text: string, targets: string[] = [], holderUri: string | null = HOLDER) {
  const paragraph = schema.nodes.paragraph.create(null, schema.text(text));
  return linkPastedWikilinks(new Slice(paragraph.content, 0, 0), schema, {
    holderUri,
    targets,
    linkAhead: (name, folders) => {
      const uri = linkAheadAddress(holderUri, name, folders);
      return uri ? { uri } : null;
    },
  }).content;
}

it.each([
  ["See [[Gate]].", "See Gate.", "Gate.md"],
  ["[[Gate|the gate]]", "the gate", "Gate.md"],
  ["[[Gate\\|the gate]]", "the gate", "Gate.md"],
  ["[[Gate#Heading]]", "Gate", "Gate.md#Heading"],
  ["[[Gate#^block]]", "Gate", "Gate.md#^block"],
  ["[[Arc 1/Gate.md]]", "Gate", "../Arc 1/Gate.md"],
])("parses %s without losing its label or suffix", (input, text, href) => {
  const out = paste(input);
  expect(out.textBetween(0, out.size)).toBe(text);
  const links: string[] = [];
  out.forEach((node) => {
    links.push(...node.marks.map((mark) => mark.attrs.href));
  });
  expect(links).toEqual([href]);
});

it.each([
  "![[map.png]]",
  "[[]]",
  "[[#Heading]]",
  "[[a//b]]",
  "[[a\nb]]",
  "`[[code]]`",
  "[\\[Gate]]",
])("leaves non-links %s literal", (input) => {
  const out = paste(input);
  expect(out.textBetween(0, out.size)).toBe(input);
  out.forEach((node) => {
    expect(node.marks).toEqual([]);
  });
});

it.each([
  [
    ["manuscript://notes/old/Gate.md", "manuscript://Gate.md", "manuscript://volume-1/Gate.md"],
    "Gate",
    "Gate.md",
  ],
  [["manuscript://notes/old/Gate.md", "manuscript://Gate.md"], "Gate", "../Gate.md"],
  [["kb://Gate.md", "manuscript://notes/deep/Gate.md"], "Gate", "../notes/deep/Gate.md"],
  [["kb://a/b/Gate.md", "kb://z/Gate.md"], "Gate", "kb://z/Gate.md"],
  [["kb://places/Gate.md", "kb://lore/Gate.md"], "Gate", "kb://lore/Gate.md"],
  [
    ["manuscript://old/places/Gate.md", "kb://places/Gate.md", "manuscript://places/Gate.md"],
    "places/Gate",
    "../places/Gate.md",
  ],
  [
    ["manuscript://old/places/Gate.md", "user://places/Gate.md", "kb://places/Gate.md"],
    "places/Gate",
    "kb://places/Gate.md",
  ],
  [["manuscript://old/places/Gate.md"], "places/Gate", "../old/places/Gate.md"],
  [["kb://characters/Lin Feng.md"], "lin feng", "kb://characters/Lin Feng.md"],
  [["kb://maps/map.png"], "Map.PNG", "kb://maps/map.png"],
])("ranks %j for [[%s]] independent of catalog order", (targets, name, expected) => {
  for (const ordered of [targets, [...targets].reverse()]) {
    expect(paste(`[[${name}]]`, ordered).firstChild?.marks[0]?.attrs.href).toBe(expected);
  }
});

it("keeps the casing of unmatched names even when they share a lookup key", () => {
  const out = paste("[[kael]] [[Kael]]");
  expect(out.firstChild?.marks[0]?.attrs.href).toBe("kael.md");
  expect(out.lastChild?.marks[0]?.attrs.href).toBe("Kael.md");
});

it("uses the shallowest target without a holder and spells a missing path from the root", () => {
  expect(
    paste("[[Gate]]", ["kb://a/b/Gate.md", "user://Gate.md"], null).firstChild?.marks[0]?.attrs
      .href,
  ).toBe("user://Gate.md");
  expect(paste("[[Arc 1/Kael]]", [], null).firstChild?.marks[0]?.attrs.href).toBe(
    "manuscript://Arc 1/Kael.md",
  );
});
