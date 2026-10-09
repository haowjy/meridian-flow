/** Image sizes, source-less slots, and literal attributes survive both codec dialects. */

import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { components, docFrom, paragraph, parsedDoc, schema } from "./codec-test-support.js";
import { markdownCodec, mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "./index.js";

const links = UNSCOPED_DOCUMENT_LINKS;
const dialects = [
  { name: "markdown", codec: markdownCodec({ schema }) },
  { name: "mdx", codec: mdxCodec({ schema, components }) },
] as const;

const PLAIN = "![World map](assets/map.png)";
const SIZED = '<img src="assets/map.png" alt="World map" width="240" />';
const ENTITY_SIZED =
  '<img src="assets/realm&amp;&quot;map&quot;.png" alt="Realm &amp; &quot;map&quot;" title="The &quot;realm&quot; &amp; beyond" width="240" />';
const LITERAL_ENTITY_SIZED =
  '<img src="assets/literal&amp;amp;map.png" alt="Literal &amp;amp; map" title="Literal &amp;quot; token" width="241" />';

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
  it.each([
    '<img src="assets/map.png" alt="World map" width="240">',
    'Before <img src="assets/map.png" alt="World map" width="240"> after.',
  ])("reads an HTML void image without a closing slash: %s", (wire) => {
    const closed = wire.replace('width="240">', 'width="240" />');
    const blocks = codec.parse(wire).blocks;
    expect(docFrom(blocks).toJSON()).toEqual(parsedDoc(codec, closed).toJSON());
    expect(codec.serialize(blocks, links)).toBe(`${closed}\n`);
  });

  it("de-escalates to byte-identical markdown when the size is taken away", () => {
    const sized = codec.parse(SIZED).blocks[0];
    if (!sized?.firstChild) throw new Error("expected a sized picture");
    const cleared = paragraph(
      sized.firstChild.type.create({ ...sized.firstChild.attrs, width: null }),
    );
    expect(codec.serialize([cleared], links)).toBe(`${PLAIN}\n`);
  });

  it("decodes a sized HTML picture once and stays stable across saves", () => {
    const first = codec.serialize(codec.parse(ENTITY_SIZED).blocks, links);
    const second = codec.serialize(codec.parse(first).blocks, links);

    expect(first).toBe(`${ENTITY_SIZED}\n`);
    expect(second).toBe(first);
    expect(codec.parse(ENTITY_SIZED).blocks[0]?.firstChild?.attrs).toMatchObject({
      src: 'assets/realm&"map".png',
      alt: 'Realm & "map"',
      title: 'The "realm" & beyond',
      width: 240,
    });
  });

  it("decodes a sized picture in a spanned HTML table once across saves", () => {
    const wire = spannedTable(ENTITY_SIZED);
    const first = codec.serialize(codec.parse(wire).blocks, links);
    const second = codec.serialize(codec.parse(first).blocks, links);
    const tableImage = codec.parse(wire).blocks[0]?.firstChild?.firstChild?.firstChild?.firstChild;

    expect(first).toBe(`${spannedTable(ENTITY_SIZED, true)}\n`);
    expect(second).toBe(first);
    expect(tableImage?.attrs).toMatchObject({
      src: 'assets/realm&"map".png',
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
    const first = codec.serialize(codec.parse(wire).blocks, links);
    const second = codec.serialize(codec.parse(first).blocks, links);
    const parsedImage = imageAt(codec.parse(wire).blocks);

    expect(first).toBe(`${canonical}\n`);
    expect(second).toBe(first);
    expect(parsedImage?.attrs).toMatchObject({
      src: "assets/literal&amp;map.png",
      alt: "Literal &amp; map",
      title: "Literal &quot; token",
      width: 241,
    });
  });

  // A slot reserved but not uploaded yet carries `src: ""`, the one source that
  // names nothing: the wire holds it without inventing an address. The token
  // naming which browser fills it is a live-session fact
  // (`apps/app/src/core/editor/images/pending-images.ts`), never written.
  it("round-trips a picture whose slot has no source yet, sized or not, without its upload token", () => {
    for (const width of [null, 240]) {
      const wire = width ? `<img src="" alt="cover art" width="${width}" />` : "![cover art]()";
      const pending = paragraph(schema.node("image", { src: "", alt: "cover art", width }));
      const inFlight = paragraph(
        schema.node("image", {
          src: "",
          alt: "cover art",
          width,
          uploadToken: "image-upload:7f3a91c0:1",
        }),
      );
      expect(codec.serialize([pending], links)).toBe(`${wire}\n`);
      expect(codec.serialize([inFlight], links)).toBe(`${wire}\n`);
      expect(parsedDoc(codec, wire).toJSON()).toEqual(docFrom([pending]).toJSON());
    }
  });
});

// A width this package could not write back the same way is not a width. The
// tag stays the text it already was rather than becoming a picture at a size
// the document never said. Both dialects hand their attributes to one shared
// reader, so the refusals run once, through the Markdown raw-HTML parser.
describe("image attribute refusals", () => {
  const codec = markdownCodec({ schema });
  it.each([
    'width="12.5"',
    'width="0"',
    'loading="lazy"',
  ])("declines an img tag carrying %s", (attribute) => {
    const wire = `<img src="assets/map.png" alt="World map" ${attribute} />`;
    expect(codec.parse(wire).blocks[0]?.firstChild?.type.name).not.toBe("image");
  });
});
