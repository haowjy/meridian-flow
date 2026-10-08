import { describe, expect, it } from "vitest";

import { unresolvedAssetPathResolver } from "./asset-path-resolver.js";
import { createMarkupCodec } from "./codec.js";
import { components, m, paragraph, schema, t } from "./codec-test-support.js";
import { markdownCodec, mdxCodec } from "./index.js";
import {
  markdownBlockCodecs,
  markdownMarkCodecs,
  markdownRequiredBlockNames,
} from "./markdown/index.js";
import { mdxBlockCodecs } from "./mdx/index.js";

describe("codec presets", () => {
  it("fails creation when schema-derived block coverage is incomplete", () => {
    expect(() =>
      createMarkupCodec({ schema, assetPathResolver: unresolvedAssetPathResolver })
        .use({
          blocks: mdxBlockCodecs(components).filter((block) => block.name !== "figure"),
          marks: markdownMarkCodecs,
        })
        .build({ requireSchemaBlockCoverage: true }),
    ).toThrow('codec missing BlockCodec for schema node "figure"');
  });

  it("dispatches inline parse and serialize through registered mark codecs", () => {
    const customSerializeCodec = createMarkupCodec({
      schema,
      assetPathResolver: unresolvedAssetPathResolver,
    })
      .use({
        blocks: markdownBlockCodecs,
        marks: markdownMarkCodecs.map((mark) =>
          mark.name === "strong"
            ? {
                ...mark,
                serialize(text, _attrs, _ctx) {
                  return `[${text}](https://custom.example)`;
                },
              }
            : mark,
        ),
      })
      .build({ requiredBlockNames: markdownRequiredBlockNames });
    expect(customSerializeCodec.serialize([paragraph(t("x", [m("strong")]))])).toBe(
      "[x](https://custom.example)\n",
    );

    const customParseCodec = createMarkupCodec({
      schema,
      assetPathResolver: unresolvedAssetPathResolver,
    })
      .use({
        blocks: markdownBlockCodecs,
        marks: markdownMarkCodecs.map((mark) =>
          mark.name === "strong" ? { ...mark, parse: () => null } : mark,
        ),
      })
      .build({ requiredBlockNames: markdownRequiredBlockNames });
    const parsed = customParseCodec.parse("**x**").blocks[0];
    expect(parsed?.firstChild?.marks).toHaveLength(0);
  });
});

describe("explicit links and bare URL round trips", () => {
  const codecs = [
    {
      name: "markdown",
      codec: markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
    },
    { name: "mdx", codec: mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }) },
  ];
  const addressLink = paragraph(t("kb://a.md", [m("link", { href: "kb://a.md", title: null })]));

  it.each([
    {
      rule: "angle autolink",
      input: "<kb://a.md>",
      expected: addressLink,
      mdxExpected: paragraph(t("<kb://a.md>")),
    },
    {
      rule: "centered address link",
      input: null,
      initial: schema.node("paragraph", { align: "center" }, addressLink.content),
      expected: addressLink,
      mdxExpected: schema.node("paragraph", { align: "center" }, addressLink.content),
    },
    {
      rule: "matching address with underscores",
      input: null,
      expected: paragraph(t("https://x/_a_", [m("link", { href: "https://x/_a_", title: null })])),
    },
    {
      rule: "bare URL in prose",
      input: "Visit https://x, www.example.com and a@b.c today.",
      expected: paragraph(t("Visit https://x, www.example.com and a@b.c today.")),
    },
  ])("$rule", ({ input, initial, expected, mdxExpected }) => {
    for (const { name, codec } of codecs) {
      const target = name === "mdx" ? (mdxExpected ?? expected) : expected;
      const parsed = codec.parse(input ?? codec.serialize([initial ?? expected])).blocks;
      expect(parsed.map((block) => block.toJSON())).toEqual([target.toJSON()]);
      const wire = codec.serialize(parsed);
      expect(codec.parse(wire).blocks.map((block) => block.toJSON())).toEqual([target.toJSON()]);
    }
  });
});
