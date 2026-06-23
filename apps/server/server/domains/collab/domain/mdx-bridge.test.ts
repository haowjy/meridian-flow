import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";

import { docToMdx, documentMdxSchema, MDX_STRINGIFY_OPTIONS, mdxToDoc } from "./mdx-bridge.js";

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

function paraTextParts(doc: PMNode): { text: string; code: boolean }[] {
  const parts: { text: string; code: boolean }[] = [];
  doc.firstChild?.forEach((child) => {
    if (child.type.name === "text") {
      parts.push({
        text: child.text ?? "",
        code: child.marks.some((mark) => mark.type.name === "code"),
      });
    }
  });
  return parts;
}

describe("mdx-bridge", () => {
  it("round-trips the full supported node set", () => {
    expect(roundTripEq(buildFullDoc())).toBe(true);
  });

  it("serializes deterministically as a byte-stable fixed point", () => {
    const s1 = docToMdx(buildFullDoc());
    const s2 = docToMdx(mdxToDoc(s1));
    const s3 = docToMdx(mdxToDoc(s2));
    expect(s1).toBe(s2);
    expect(s2).toBe(s3);
    expect(MDX_STRINGIFY_OPTIONS.bullet).toBe("-");
  });

  it("escapes prose < and { without changing the parsed text", () => {
    for (const text of ["HP <50 and dropping fast.", "the {void} stirred beneath the city."]) {
      const doc = schema.node("doc", null, [para(t(text))]);
      expect(mdxToDoc(docToMdx(doc)).firstChild?.firstChild?.text).toBe(text);
    }
  });

  it("preserves empty paragraphs through the sentinel wire form", () => {
    const doc = schema.node("doc", null, [para(t("before")), empty(), para(t("after"))]);
    const wire = docToMdx(doc);
    expect(wire).toContain("\n\u00a0\n");
    expect(mdxToDoc(wire).eq(doc)).toBe(true);
  });

  it("preserves inline code containing MDX-sensitive characters", () => {
    const doc = mdxToDoc("before `a<b{c}` after");
    expect(paraTextParts(doc)).toEqual([
      { text: "before ", code: false },
      { text: "a<b{c}", code: true },
      { text: " after", code: false },
    ]);
  });
});
