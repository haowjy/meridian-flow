import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";

import {
  blockToMdx,
  docToMdx,
  documentMdxSchema,
  MDX_STRINGIFY_OPTIONS,
  mdxToDoc,
} from "./mdx-bridge.js";

const schema = documentMdxSchema();
const t = (s: string, marks?: readonly ReturnType<typeof schema.marks.strong.create>[]) =>
  schema.text(s, marks);
const m = (name: "strong" | "em" | "code" | "link", attrs?: Record<string, unknown>) =>
  schema.marks[name].create(attrs);
const para = (...kids: PMNode[]) => schema.node("paragraph", null, kids);
const empty = () => schema.node("paragraph", null, []);

function roundTripEq(doc: PMNode): boolean {
  return mdxToDoc(docToMdx(doc)).eq(doc);
}

function sentinelCount(wire: string): number {
  return wire.split("\n").filter((line) => line === "\u00a0").length;
}

function buildFullDoc(): PMNode {
  return schema.node("doc", null, [
    schema.node("heading", { level: 1 }, [t("The Ascension Trial")]),
    schema.node("paragraph", null, [
      t("Plain text, then "),
      t("bold", [m("strong")]),
      t(", "),
      t("italic", [m("em")]),
      t(", "),
      t("code()", [m("code")]),
      t(", and a "),
      t("link", [m("link", { href: "https://example.com", title: "Ex" })]),
      t("."),
    ]),
    schema.node("paragraph", null, [
      t("nested "),
      t("bold-italic", [m("strong"), m("em")]),
      t(" word."),
    ]),
    schema.node("paragraph", null, [t("line one"), schema.node("hard_break"), t("line two")]),
    schema.node("blockquote", null, [schema.node("paragraph", null, [t("A quoted line.")])]),
    schema.node("bullet_list", { tight: true }, [
      schema.node("list_item", null, [schema.node("paragraph", null, [t("first")])]),
      schema.node("list_item", null, [schema.node("paragraph", null, [t("second")])]),
    ]),
    schema.node("ordered_list", { order: 3, tight: false }, [
      schema.node("list_item", null, [schema.node("paragraph", null, [t("three")])]),
      schema.node("list_item", null, [schema.node("paragraph", null, [t("four")])]),
    ]),
    schema.node("code_block", { language: "rust" }, [t("fn main() {}")]),
    schema.node("math_display", null, [t("E = mc^2")]),
    schema.node("table", null, [
      schema.node("table_row", null, [
        schema.node("table_header", null, [t("Stat")]),
        schema.node("table_header", null, [t("Value")]),
      ]),
      schema.node("table_row", null, [
        schema.node("table_cell", null, [t("HP")]),
        schema.node("table_cell", null, [t("100")]),
      ]),
    ]),
    schema.node("paragraph", null, [
      t("inline image "),
      schema.node("image", { src: "img/sword.png", alt: "a sword", title: null }),
      t(" here."),
    ]),
    schema.node("figure", {
      src: "uploads://w1/map.png",
      alt: "Realm map",
      caption: "The northern provinces",
      label: "fig-map",
    }),
    schema.node("horizontal_rule"),
    schema.node("paragraph", null, [t("After the break.")]),
  ]);
}

describe("mdx-bridge — full node set round-trip", () => {
  it("round-trips the full node set with doc.eq", () => {
    const original = buildFullDoc();
    expect(roundTripEq(original)).toBe(true);
  });
});

describe("mdx-bridge — determinism", () => {
  it("serialize is a byte-stable fixed point", () => {
    const doc = buildFullDoc();
    const s1 = docToMdx(doc);
    const s2 = docToMdx(mdxToDoc(s1));
    const s3 = docToMdx(mdxToDoc(s2));
    expect(s1).toBe(s2);
    expect(s2).toBe(s3);
    expect(MDX_STRINGIFY_OPTIONS.bullet).toBe("-");
  });
});

describe("mdx-bridge — prose safety", () => {
  const samples = [
    "HP <50 and dropping fast.",
    "the {void} stirred beneath the city.",
    "She whispered </battle> like a curse.",
    "An empty gesture: {} meant nothing.",
    "Mana < 10 < 20 ranges, and a {} sigil.",
    "Tag-like <name> but not a real component.",
    "Math-ish a<b and c>d inline.",
  ];

  it("round-trips literal < and { in prose via serialize", () => {
    for (const s of samples) {
      const doc = schema.node("doc", null, [para(t(s))]);
      const wire = docToMdx(doc);
      const back = mdxToDoc(wire);
      expect(back.firstChild?.firstChild?.text).toBe(s);
    }
  });

  it("parses raw external markdown with prose < and { without throwing", () => {
    for (const s of samples) {
      const back = mdxToDoc(s);
      expect(back.firstChild?.firstChild?.text).toBe(s);
    }
  });

  it("escape is idempotent under repeated serialize", () => {
    const doc = schema.node("doc", null, [para(t("HP <50 and **bold**"))]);
    const s1 = docToMdx(doc);
    const s2 = docToMdx(mdxToDoc(s1));
    expect(s1).toBe(s2);
  });

  it("bridge-produced MDX round-trips with doc.eq (no double-escape)", () => {
    const doc = schema.node("doc", null, [para(t("HP <50")), para(t("the {void} stirred."))]);
    const wire = docToMdx(doc);
    expect(mdxToDoc(wire).eq(doc)).toBe(true);
  });
});

describe("mdx-bridge — empty paragraphs", () => {
  it("blank_document (single empty paragraph)", () => {
    const doc = schema.node("doc", null, [empty()]);
    const wire = docToMdx(doc);
    expect(roundTripEq(doc)).toBe(true);
    expect(sentinelCount(wire)).toBe(1);
  });

  it("single_empty_paragraph between prose", () => {
    const doc = schema.node("doc", null, [para(t("a")), empty(), para(t("b"))]);
    const wire = docToMdx(doc);
    expect(roundTripEq(doc)).toBe(true);
    expect(sentinelCount(wire)).toBe(1);
  });

  it("consecutive_empty_paragraphs_2", () => {
    const doc = schema.node("doc", null, [para(t("a")), empty(), empty(), para(t("b"))]);
    expect(roundTripEq(doc)).toBe(true);
    expect(sentinelCount(docToMdx(doc))).toBe(2);
  });

  it("consecutive_empty_paragraphs_3plus", () => {
    const doc = schema.node("doc", null, [para(t("a")), empty(), empty(), empty(), para(t("b"))]);
    expect(roundTripEq(doc)).toBe(true);
    expect(sentinelCount(docToMdx(doc))).toBe(3);
  });

  it("leading_and_trailing_empty_paragraphs", () => {
    const doc = schema.node("doc", null, [empty(), para(t("middle")), empty()]);
    expect(roundTripEq(doc)).toBe(true);
    expect(sentinelCount(docToMdx(doc))).toBe(2);
  });

  it("empty_paragraph_with_marks_and_figure", () => {
    const doc = schema.node("doc", null, [
      schema.node("heading", { level: 1 }, [t("Chapter One")]),
      empty(),
      para(t("The road climbed.")),
      empty(),
      empty(),
      schema.node("figure", {
        src: "uploads://w1/map.png",
        alt: "Map",
        caption: "The pass",
        label: null,
      }),
      empty(),
      para(t("The end.")),
    ]);
    const wire = docToMdx(doc);
    expect(roundTripEq(doc)).toBe(true);
    expect(sentinelCount(wire)).toBe(4);
  });

  it("hard_break adjacent to empty paragraph", () => {
    const doc = schema.node("doc", null, [
      para(t("line one"), schema.node("hard_break"), t("line two")),
      empty(),
      para(t("after the gap")),
    ]);
    expect(roundTripEq(doc)).toBe(true);
    expect(sentinelCount(docToMdx(doc))).toBe(1);
  });

  it("canonicalizes whitespace-only paragraphs to empty (fixed point)", () => {
    for (const ws of [" ", "\u00a0", "\t", "  \t "]) {
      const wsDoc = schema.node("doc", null, [para(t(ws))]);
      const wire = docToMdx(wsDoc);
      const emptyDoc = schema.node("doc", null, [empty()]);
      expect(sentinelCount(wire)).toBe(1);
      expect(wire).not.toContain("&#x20;");
      expect(mdxToDoc(wire).eq(emptyDoc)).toBe(true);
      expect(docToMdx(emptyDoc)).toBe(wire);
    }
  });
});

describe("mdx-bridge — edge cases", () => {
  it("raw_url_literal_text (autolink demotion)", () => {
    const doc = schema.node("doc", null, [para(t("visit https://example.com today"))]);
    expect(roundTripEq(doc)).toBe(true);
    const wire = docToMdx(doc);
    expect(wire).not.toContain("](https://");
  });

  it("explicit link preserved", () => {
    const doc = schema.node("doc", null, [
      para(
        t("see "),
        t("the site", [m("link", { href: "https://example.com", title: null })]),
        t(" now"),
      ),
    ]);
    expect(roundTripEq(doc)).toBe(true);
  });

  it("adjacent_blockquotes", () => {
    const doc = schema.node("doc", null, [
      schema.node("blockquote", null, [para(t("one"))]),
      schema.node("blockquote", null, [para(t("two"))]),
    ]);
    expect(roundTripEq(doc)).toBe(true);
  });

  it("list_then_paragraph", () => {
    const doc = schema.node("doc", null, [
      schema.node("bullet_list", { tight: true }, [
        schema.node("list_item", null, [para(t("item"))]),
      ]),
      para(t("after list")),
    ]);
    expect(roundTripEq(doc)).toBe(true);
  });

  it("bullet_list_then_ordered_start_3", () => {
    const doc = schema.node("doc", null, [
      schema.node("bullet_list", { tight: true }, [
        schema.node("list_item", null, [para(t("bullet"))]),
      ]),
      schema.node("ordered_list", { order: 3, tight: true }, [
        schema.node("list_item", null, [para(t("three"))]),
        schema.node("list_item", null, [para(t("four"))]),
      ]),
    ]);
    expect(roundTripEq(doc)).toBe(true);
    expect(docToMdx(doc)).toContain("3.");
  });

  it("link_title_with_quotes", () => {
    const doc = schema.node("doc", null, [
      para(t("link", [m("link", { href: "https://x.com", title: 'say "hi"' })])),
    ]);
    expect(roundTripEq(doc)).toBe(true);
  });

  it("code_fence_with_triple_backticks_inside", () => {
    const inner = `${"`".repeat(3)}\ninside\n${"`".repeat(3)}`;
    const doc = schema.node("doc", null, [
      schema.node("code_block", { language: null }, [t(inner)]),
    ]);
    const wire = docToMdx(doc);
    expect(wire.startsWith("````\n")).toBe(true);
    expect(roundTripEq(doc)).toBe(true);
  });

  it("escaped_chars_adjacent_to_marks", () => {
    const doc = schema.node("doc", null, [para(t("HP <50", [m("strong")]))]);
    expect(roundTripEq(doc)).toBe(true);
  });

  it("horizontal_rule scene break", () => {
    const doc = schema.node("doc", null, [
      para(t("before")),
      schema.node("horizontal_rule"),
      para(t("after")),
    ]);
    expect(roundTripEq(doc)).toBe(true);
    expect(docToMdx(doc)).toContain("---");
  });

  it("linked_image is impossible (image marks forbidden in schema)", () => {
    expect(schema.nodes.image.spec.marks).toBe("");
  });

  it("table_first_row_is_cells normalizes on round-trip", () => {
    const doc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("table_row", null, [
          schema.node("table_cell", null, [t("A")]),
          schema.node("table_cell", null, [t("B")]),
        ]),
        schema.node("table_row", null, [
          schema.node("table_cell", null, [t("1")]),
          schema.node("table_cell", null, [t("2")]),
        ]),
      ]),
    ]);
    const back = mdxToDoc(docToMdx(doc));
    expect(back.firstChild?.child(0)?.firstChild?.type.name).toBe("table_header");
    expect(back.eq(doc)).toBe(false);
  });

  it("table_later_header_row normalizes on round-trip", () => {
    const doc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("table_row", null, [schema.node("table_header", null, [t("H")])]),
        schema.node("table_row", null, [schema.node("table_header", null, [t("bad")])]),
      ]),
    ]);
    const back = mdxToDoc(docToMdx(doc));
    const row1 = back.firstChild?.child(1)?.firstChild;
    expect(row1?.type.name).toBe("table_cell");
  });
});

describe("mdx-bridge — allowlist negatives", () => {
  it("rejects unknown component", () => {
    expect(() => mdxToDoc("<Unknown />\n")).toThrow(/unknown component/);
  });

  it("rejects spread attr (remark-mdx classifies {...props} as expression)", () => {
    expect(() => mdxToDoc('<Figure src="x" {...props} />\n')).toThrow(/spread|expression/);
  });

  it("rejects expression attr", () => {
    expect(() => mdxToDoc("<Figure src={url} />\n")).toThrow(/expression/);
  });

  it("rejects unknown Figure attribute", () => {
    expect(() => mdxToDoc('<Figure src="x" foo="bar" />\n')).toThrow(/unknown attribute "foo"/);
  });

  it("rejects Figure with non-empty children", () => {
    expect(() => mdxToDoc("<Figure>child</Figure>\n")).toThrow(/non-empty children forbidden/);
  });
});

describe("mdx-bridge — golden wire fixture", () => {
  it("emits the exact representative MDX wire format", () => {
    const doc = schema.node("doc", null, [
      schema.node("heading", { level: 1 }, [t("Title")]),
      para(t("bold bit", [m("strong")])),
      schema.node("bullet_list", { tight: true }, [
        schema.node("list_item", null, [para(t("one"))]),
      ]),
      schema.node("ordered_list", { order: 3, tight: true }, [
        schema.node("list_item", null, [para(t("three"))]),
      ]),
      schema.node("code_block", { language: "js" }, [t("console.log(1)")]),
      schema.node("figure", {
        src: "img.png",
        alt: "Alt",
        caption: "Cap",
        label: "fig-1",
      }),
      empty(),
      para(t("tail")),
    ]);
    expect(docToMdx(doc)).toBe(
      '# Title\n\n**bold bit**\n\n- one\n\n3. three\n\n```js\nconsole.log(1)\n```\n\n<Figure src="img.png" alt="Alt" caption="Cap" label="fig-1" />\n\n\u00a0\n\ntail\n',
    );
  });
});

describe("mdx-bridge — blank ingress", () => {
  it("maps empty and whitespace-only input to a single empty paragraph", () => {
    for (const input of ["", " \n\t"]) {
      const doc = mdxToDoc(input);
      expect(doc.childCount).toBe(1);
      expect(doc.firstChild?.type.name).toBe("paragraph");
      expect(doc.firstChild?.childCount).toBe(0);
    }
  });
});

describe("mdx-bridge — blockToMdx", () => {
  it("serializes a single block", () => {
    const block = para(t("lone"));
    expect(blockToMdx(block)).toBe("lone\n");
  });
});
