import { describe, expect, it } from "vitest";

import { unresolvedAssetPathResolver } from "./asset-path-resolver.js";
import { components, m, paragraph, schema, sorted, t } from "./codec-test-support.js";
import { createMarkupCodec, mdxCodec, requiredBlockNamesForSchema } from "./index.js";
import {
  markdownBlockCodecs,
  markdownMarkCodecs,
  markdownRequiredBlockNames,
} from "./markdown/index.js";
import { mdxBlockCodecs } from "./mdx/index.js";

describe("codec presets", () => {
  it("registers every markdown node and mark codec", () => {
    expect(markdownBlockCodecs.map((block) => block.name).sort()).toEqual(
      [...markdownRequiredBlockNames].sort(),
    );
    expect(markdownMarkCodecs.map((mark) => mark.name).sort()).toEqual([
      "code",
      "em",
      "link",
      "strike",
      "strong",
    ]);
  });

  it("registers every fiction-schema node handled by the MDX codec", () => {
    mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver, components });
    const schemaRequiredBlocks = sorted(requiredBlockNamesForSchema(schema));
    expect(sorted(mdxBlockCodecs(components).map((block) => block.name))).toEqual(
      [...schemaRequiredBlocks, "layout"].sort(),
    );
    expect(markdownMarkCodecs.map((mark) => mark.name).sort()).toEqual([
      "code",
      "em",
      "link",
      "strike",
      "strong",
    ]);
  });

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
