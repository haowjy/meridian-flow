/**
 * The escalation ladder a picture climbs when the writer gives it a size.
 *
 * Two claims are load-bearing and both are checked in both dialects: a picture
 * nobody resized spells itself exactly as it always did, and a picture that was
 * resized carries its width across the wire and back without losing its
 * `asset:` identity.
 */

import { describe, expect, it } from "vitest";

import { createAssetPathResolver } from "./asset-path-resolver.js";
import { components, docFrom, paragraph, parsedDoc, schema, t } from "./codec-test-support.js";
import { markdownCodec, mdxCodec } from "./index.js";

const assetPathResolver = createAssetPathResolver([
  ["asset-1", "assets/map.png"],
  ["asset-entity", 'assets/realm&"map".png'],
]);
const dialects = [
  { name: "markdown", codec: markdownCodec({ schema, assetPathResolver }) },
  { name: "mdx", codec: mdxCodec({ schema, assetPathResolver, components }) },
] as const;

const PLAIN = "![World map](assets/map.png)";
const SIZED = '<img src="assets/map.png" alt="World map" width="240" />';
const ENTITY_SIZED =
  '<img src="assets/realm&amp;&quot;map&quot;.png" alt="Realm &amp; &quot;map&quot;" title="The &quot;realm&quot; &amp; beyond" width="240" />';

function image(attrs: Record<string, unknown>) {
  return schema.node("image", { src: "asset:asset-1", alt: "World map", title: null, ...attrs });
}

describe.each(dialects)("$name image sizes", ({ codec }) => {
  it("leaves an unsized picture in plain markdown syntax", () => {
    expect(codec.serialize([paragraph(image({ width: null }))])).toBe(`${PLAIN}\n`);
    expect(parsedDoc(codec, PLAIN).toJSON()).toEqual(docFrom([paragraph(image({}))]).toJSON());
  });

  it("escalates a sized picture to the img tag and reads it back whole", () => {
    expect(codec.serialize([paragraph(image({ width: 240 }))])).toBe(`${SIZED}\n`);
    expect(parsedDoc(codec, SIZED).toJSON()).toEqual(
      docFrom([paragraph(image({ width: 240 }))]).toJSON(),
    );
  });

  it("de-escalates to byte-identical markdown when the size is taken away", () => {
    const sized = codec.parse(SIZED).blocks[0];
    if (!sized?.firstChild) throw new Error("expected a sized picture");
    const cleared = paragraph(
      sized.firstChild.type.create({ ...sized.firstChild.attrs, width: null }),
    );
    expect(codec.serialize([cleared])).toBe(`${PLAIN}\n`);
  });

  it("carries a sized picture standing among words", () => {
    const wire = `Before ${SIZED} after.`;
    const blocks = codec.parse(wire).blocks;
    expect(codec.serialize(blocks)).toBe(`${wire}\n`);
    expect(docFrom(blocks).toJSON()).toEqual(
      docFrom([paragraph(t("Before "), image({ width: 240 }), t(" after."))]).toJSON(),
    );
  });

  it("keeps a title beside the width", () => {
    const wire = '<img src="assets/map.png" alt="World map" title="The realm" width="96" />';
    expect(codec.serialize(codec.parse(wire).blocks)).toBe(`${wire}\n`);
    expect(codec.parse(wire).blocks[0]?.firstChild?.attrs.title).toBe("The realm");
  });

  it("decodes a sized HTML picture once and stays stable across saves", () => {
    const first = codec.serialize(codec.parse(ENTITY_SIZED).blocks);
    const second = codec.serialize(codec.parse(first).blocks);

    expect(first).toBe(`${ENTITY_SIZED}\n`);
    expect(second).toBe(first);
    expect(codec.parse(ENTITY_SIZED).blocks[0]?.firstChild?.attrs).toMatchObject({
      src: "asset:asset-entity",
      alt: 'Realm & "map"',
      title: 'The "realm" & beyond',
      width: 240,
    });
  });

  it("decodes a sized picture in a spanned HTML table once across saves", () => {
    const wire = [
      "<table>",
      "  <tbody>",
      "    <tr>",
      `      <td rowspan="2">${ENTITY_SIZED}</td>`,
      "      <td>Upper</td>",
      "    </tr>",
      "    <tr>",
      "      <td>Lower</td>",
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n");
    const first = codec.serialize(codec.parse(wire).blocks);
    const second = codec.serialize(codec.parse(first).blocks);
    const tableImage = codec.parse(wire).blocks[0]?.firstChild?.firstChild?.firstChild?.firstChild;

    expect(first).toBe(`${wire}\n`);
    expect(second).toBe(first);
    expect(tableImage?.attrs).toMatchObject({
      src: "asset:asset-entity",
      alt: 'Realm & "map"',
      title: 'The "realm" & beyond',
      width: 240,
    });
  });

  it("sizes a picture whose slot has no source yet", () => {
    const wire = '<img src="" alt="cover art" width="240" />';
    const pending = paragraph(schema.node("image", { src: "", alt: "cover art", width: 240 }));
    expect(codec.serialize([pending])).toBe(`${wire}\n`);
    expect(parsedDoc(codec, wire).toJSON()).toEqual(docFrom([pending]).toJSON());
  });

  // A width this package could not write back the same way is not a width. The
  // tag stays the text it already was rather than becoming a picture at a size
  // the document never said.
  it.each([
    'width="50%"',
    'width="12.5"',
    'width="0"',
    'loading="lazy"',
  ])("declines an img tag carrying %s", (attribute) => {
    const wire = `<img src="assets/map.png" alt="World map" ${attribute} />`;
    expect(codec.parse(wire).blocks[0]?.firstChild?.type.name).not.toBe("image");
  });
});

describe("sized pictures in the other spellings", () => {
  const codec = mdxCodec({ schema, assetPathResolver, components });

  it("sizes a wikilink picture without losing the wikilink", () => {
    const wire = '<img src="[[Realm map]]" alt="World map" width="240" />';
    expect(codec.parse(wire).blocks[0]?.firstChild?.attrs.src).toBe("[[Realm map]]");
    expect(codec.serialize(codec.parse(wire).blocks)).toBe(`${wire}\n`);
  });

  it("sizes a picture inside an HTML table cell", () => {
    const wire = [
      "<table>",
      "  <tbody>",
      "    <tr>",
      `      <td>${SIZED}</td>`,
      "    </tr>",
      "  </tbody>",
      "</table>",
    ].join("\n");
    const blocks = codec.parse(wire).blocks;
    expect(codec.serialize(blocks)).toBe(`${wire}\n`);
    const cell = blocks[0]?.firstChild?.firstChild?.firstChild;
    expect(cell?.firstChild?.attrs.width).toBe(240);
  });
});
