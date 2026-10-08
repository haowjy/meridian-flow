/** Image sizes, asset identity, and literal attributes survive both codec dialects. */

import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";

import { createAssetPathResolver } from "./asset-path-resolver.js";
import { components, docFrom, paragraph, parsedDoc, schema } from "./codec-test-support.js";
import { markdownCodec, mdxCodec } from "./index.js";

const assetPathResolver = createAssetPathResolver([
  ["asset-1", "assets/map.png"],
  ["asset-entity", 'assets/realm&"map".png'],
  ["asset-literal", "assets/literal&amp;map.png"],
  ["asset-named", "assets/café©.png"],
]);
const dialects = [
  { name: "markdown", codec: markdownCodec({ schema, assetPathResolver }) },
  { name: "mdx", codec: mdxCodec({ schema, assetPathResolver, components }) },
] as const;

const PLAIN = "![World map](assets/map.png)";
const SIZED = '<img src="assets/map.png" alt="World map" width="240" />';
const ENTITY_SIZED =
  '<img src="assets/realm&amp;&quot;map&quot;.png" alt="Realm &amp; &quot;map&quot;" title="The &quot;realm&quot; &amp; beyond" width="240" />';
const LITERAL_ENTITY_SIZED =
  '<img src="assets/literal&amp;amp;map.png" alt="Literal &amp;amp; map" title="Literal &amp;quot; token" width="241" />';

function _image(attrs: Record<string, unknown>) {
  return schema.node("image", { src: "asset:asset-1", alt: "World map", title: null, ...attrs });
}

function spannedTable(imageWire: string, canonical = false): string {
  const cell = (content: string) =>
    canonical
      ? [`      <td>`, `        <p>${content}</p>`, "      </td>"]
      : [`      <td>${content}</td>`];
  const spannedCell = canonical
    ? ['      <td rowspan="2">', `        <p>${imageWire}</p>`, "      </td>"]
    : [`      <td rowspan="2">${imageWire}</td>`];
  return [
    "<table>",
    "  <tbody>",
    "    <tr>",
    ...spannedCell,
    ...cell("Upper"),
    "    </tr>",
    "    <tr>",
    ...cell("Lower"),
    "    </tr>",
    "  </tbody>",
    "</table>",
  ].join("\n");
}

describe.each(dialects)("$name image sizes", ({ codec }) => {
  it("de-escalates to byte-identical markdown when the size is taken away", () => {
    const sized = codec.parse(SIZED).blocks[0];
    if (!sized?.firstChild) throw new Error("expected a sized picture");
    const cleared = paragraph(
      sized.firstChild.type.create({ ...sized.firstChild.attrs, width: null }),
    );
    expect(codec.serialize([cleared])).toBe(`${PLAIN}\n`);
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
    const wire = spannedTable(ENTITY_SIZED);
    const first = codec.serialize(codec.parse(wire).blocks);
    const second = codec.serialize(codec.parse(first).blocks);
    const tableImage = codec.parse(wire).blocks[0]?.firstChild?.firstChild?.firstChild?.firstChild;

    expect(first).toBe(`${spannedTable(ENTITY_SIZED, true)}\n`);
    expect(second).toBe(first);
    expect(tableImage?.attrs).toMatchObject({
      src: "asset:asset-entity",
      alt: 'Realm & "map"',
      title: 'The "realm" & beyond',
      width: 240,
    });
  });

  it.each([
    {
      name: "inside a spanned table",
      wire: spannedTable(LITERAL_ENTITY_SIZED),
      canonical: spannedTable(LITERAL_ENTITY_SIZED, true),
      imageAt: (blocks: readonly PMNode[]) =>
        blocks[0]?.firstChild?.firstChild?.firstChild?.firstChild,
    },
  ])("does not decode entity-looking data twice $name", ({ wire, canonical, imageAt }) => {
    const first = codec.serialize(codec.parse(wire).blocks);
    const second = codec.serialize(codec.parse(first).blocks);
    const parsedImage = imageAt(codec.parse(wire).blocks);

    expect(first).toBe(`${canonical}\n`);
    expect(second).toBe(first);
    expect(parsedImage?.attrs).toMatchObject({
      src: "asset:asset-literal",
      alt: "Literal &amp; map",
      title: "Literal &quot; token",
      width: 241,
    });
  });

  it("sizes a picture whose slot has no source yet", () => {
    const wire = '<img src="" alt="cover art" width="240" />';
    const pending = paragraph(schema.node("image", { src: "", alt: "cover art", width: 240 }));
    expect(codec.serialize([pending])).toBe(`${wire}\n`);
    expect(parsedDoc(codec, wire).toJSON()).toEqual(docFrom([pending]).toJSON());
  });
});

// A width this package could not write back the same way is not a width. The
// tag stays the text it already was rather than becoming a picture at a size
// the document never said. Both dialects hand their attributes to one shared
// reader, so the refusals run once, through the Markdown raw-HTML parser.
describe("image attribute refusals", () => {
  const codec = markdownCodec({ schema, assetPathResolver });
  it.each([
    'width="12.5"',
    'width="0"',
    'loading="lazy"',
  ])("declines an img tag carrying %s", (attribute) => {
    const wire = `<img src="assets/map.png" alt="World map" ${attribute} />`;
    expect(codec.parse(wire).blocks[0]?.firstChild?.type.name).not.toBe("image");
  });
});
