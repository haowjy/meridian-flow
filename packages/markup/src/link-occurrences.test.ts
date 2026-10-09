/** `parseWithSpans` spans and `walkLinkOccurrences` order must name the same occurrences. */
import {
  type CatalogDocument,
  type LinkHolder,
  resolveStoredLink,
  spellStoredLink,
} from "@meridian/contracts";
import { expect, it } from "vitest";

import { components, m, paragraph, schema, t } from "./codec-test-support.js";
import { type DocumentLinkScope, mdxCodec, walkLinkOccurrences } from "./index.js";

const holder: LinkHolder = {
  uri: "manuscript://book/ch1.md",
  projectId: "p1",
  view: { kind: "live" },
};
const id = {
  ch2: "00000000-0000-4000-8000-000000000001",
  map: "00000000-0000-4000-8000-000000000002",
  fig: "00000000-0000-4000-8000-000000000003",
  open: "00000000-0000-4000-8000-000000000004",
};
const documents = new Map<string, CatalogDocument>(
  [
    [id.ch2, "manuscript://book/ch2.md"],
    [id.map, "manuscript://assets/map.png"],
    [id.fig, "manuscript://assets/fig.png"],
  ].map(([documentId = "", uri = ""]) => [
    documentId,
    { documentId, projectId: "p1", uri, presence: "live", readable: true, nameable: true },
  ]),
);
const catalog = {
  document: (id: string) => documents.get(id) ?? null,
  settlement: () => null,
  documentAt: () => null,
};
const scope: DocumentLinkScope = {
  spellLink: (link) =>
    spellStoredLink(link, holder, resolveStoredLink(link, holder, catalog), "holder"),
  spellSource: ({ src, ref }) => {
    const link = { href: src, ref };
    return spellStoredLink(
      link,
      holder,
      resolveStoredLink(link, holder, catalog),
      "manuscript-root",
    );
  },
};

const link = (href: string, ref: string | null = null) => m("link", { href, title: null, ref });
const image = (src: string, ref: string | null, width: number | null = null) =>
  schema.node("image", { src, alt: "Map", title: null, ref, width });

it("aligns parse spans with walk order for links, images, figures and table anchors", () => {
  const ch2 = link("manuscript://book/old-ch2.md", `doc:${id.ch2}`);
  const stored = [
    paragraph(
      t("See "),
      t("chapter ", [ch2]),
      t("two", [ch2, m("strong")]),
      t(", "),
      t("the web", [link("https://example.com")]),
      t(" and "),
      image("manuscript://assets/old-map.png", `doc:${id.map}`),
    ),
    schema.node("heading", { level: 2 }, [
      t("Ahead", [link("manuscript://book/ch12.md#top", `ahead:${id.open}`)]),
    ]),
    schema.node("bullet_list", { tight: true }, [
      schema.node("list_item", null, [paragraph(t("Lin", [link("../kb.md")]))]),
    ]),
    schema.node("figure", {
      src: "manuscript://assets/old-fig.png",
      alt: "Fig",
      caption: "",
      ref: `doc:${id.fig}`,
    }),
    schema.node("table", null, [
      schema.node("table_row", null, [
        schema.node("table_cell", null, [
          paragraph(
            t("in table", [ch2]),
            t(" "),
            image("manuscript://assets/old-map.png", `doc:${id.map}`),
          ),
        ]),
      ]),
    ]),
    paragraph(image("manuscript://assets/old-map.png", `doc:${id.map}`, 40)),
  ];
  const codec = mdxCodec({ schema, components });
  const text = codec.serialize(stored, scope);
  const tableText = codec.serializeBlock(stored[4] as (typeof stored)[number], scope);
  const parsed = codec.parseWithSpans(text);
  const occurrences = walkLinkOccurrences(parsed.blocks);

  // Parse is pure syntax: refs never reach the wire, so none come back.
  expect.soft(text, "wire").not.toMatch(/doc:|ahead:/);
  expect
    .soft(
      parsed.blocks.map((block) => block.toJSON()),
      "same parse",
    )
    .toEqual(codec.parse(text).blocks.map((block) => block.toJSON()));
  expect
    .soft(
      occurrences.map(({ kind, label }) => [kind, label]),
      "walk order survives the wire",
    )
    .toEqual(walkLinkOccurrences(stored).map(({ kind, label }) => [kind, label]));
  expect
    .soft(occurrences.map((occurrence) => occurrence.attrs.ref))
    .toEqual(occurrences.map(() => null));

  const rows: [string, string][] = [
    ["link run across marks", "[chapter **two**](ch2.md)"],
    ["external link", "[the web](https://example.com)"],
    ["inline image", "![Map](assets/map.png)"],
    ["ahead link in a heading", "[Ahead](ch12.md#top)"],
    ["no-ref link in a list", "[Lin](../kb.md)"],
    ["figure", '<Figure src="assets/fig.png" alt="Fig" caption="" />'],
    ["table anchor", tableText],
    ["table image", tableText],
    ["sized image", '<img src="assets/map.png" alt="Map" width="40" />'],
  ];
  expect.soft(parsed.spans, "one span per occurrence").toHaveLength(occurrences.length);
  rows.forEach(([name, expected], index) => {
    const span = parsed.spans[index];
    expect.soft(span && text.slice(span.start, span.end), name).toBe(expected);
  });
});
