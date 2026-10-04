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
    markdownCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
    mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
  ];
  const addressLink = paragraph(t("kb://a.md", [m("link", { href: "kb://a.md", title: null })]));

  it.each([
    {
      rule: "matching filename",
      input: "[a.md](a.md)",
      expected: paragraph(t("a.md", [m("link", { href: "a.md", title: null })])),
    },
    {
      rule: "matching spaced filename",
      input: "[Lin Feng.md](<Lin Feng.md>)",
      expected: paragraph(t("Lin Feng.md", [m("link", { href: "Lin Feng.md", title: null })])),
    },
    { rule: "angle autolink", input: "<kb://a.md>", expected: addressLink },
    { rule: "serialized address link", input: null, expected: addressLink },
    {
      rule: "bare URL in prose",
      input: "Visit https://x today.",
      expected: paragraph(t("Visit https://x today.")),
    },
  ])("$rule", ({ input, expected }) => {
    for (const codec of codecs) {
      const parsed = codec.parse(input ?? codec.serialize([expected])).blocks;
      expect(parsed.map((block) => block.toJSON())).toEqual([expected.toJSON()]);
      const wire = codec.serialize(parsed);
      expect(codec.parse(wire).blocks.map((block) => block.toJSON())).toEqual([expected.toJSON()]);
    }
  });
});
