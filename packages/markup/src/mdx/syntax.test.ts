/** Guard the remark-mdx token adapter: HTML closure, not permissive JSX parsing. */

import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { remarkMdxWithHtmlVoidElements } from "./syntax.js";

const parser = unified().use(remarkParse).use(remarkMdxWithHtmlVoidElements);

// Keep the contract independent of the production set so a missing name fails.
const voidNames = [
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
];

describe("MDX HTML void syntax", () => {
  it.each(voidNames)("closes %s in flow, inline and nested JSX", (name) => {
    for (const source of [`<${name}>`, `Before <${name}> after`, `<Panel><${name}></Panel>`]) {
      const actual = parser.parse(source);
      const expected = parser.parse(source.replace(`<${name}>`, `<${name} />`));
      const withoutPositions = (tree: unknown) =>
        JSON.parse(JSON.stringify(tree, (key, value) => (key === "position" ? undefined : value)));
      expect(withoutPositions(actual)).toEqual(withoutPositions(expected));
    }
  });

  it("lets MDX parse quoted angles, expressions and multiline attributes", () => {
    const source = '<img\n src="assets/a>b.png" alt="<img>" width={240}>';
    const node = parser.parse(source).children[0];
    expect(node).toMatchObject({
      type: "mdxJsxFlowElement",
      name: "img",
      children: [],
      attributes: [
        { name: "src", value: "assets/a>b.png" },
        { name: "alt", value: "<img>" },
        { name: "width", value: { value: "240" } },
      ],
      position: { end: { offset: source.length } },
    });
  });

  it.each([
    "<Panel>",
    "<Img>",
    "<img.Custom>",
    "<img:custom>",
    "<img src=assets/map.png>",
    "<img width={}>",
    "<img></img>",
    "<Panel><img></Other>",
  ])("still rejects invalid JSX: %s", (source) => {
    expect(() => parser.parse(source)).toThrow();
  });

  it("does not rewrite inline code, fenced code or escaped tags", () => {
    const source = "`<img>`\n\n```html\n<img>\n```\n\n\\<img>";
    expect(parser.parse(source).children).toMatchObject([
      { type: "paragraph", children: [{ type: "inlineCode", value: "<img>" }] },
      { type: "code", value: "<img>" },
      { type: "paragraph", children: [{ type: "text", value: "<img>" }] },
    ]);
  });
});
