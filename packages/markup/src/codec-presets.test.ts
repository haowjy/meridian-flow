import { describe, expect, it } from "vitest";

import { unresolvedAssetPathResolver } from "./asset-path-resolver.js";
import { m, paragraph, schema, t } from "./codec-test-support.js";
import { markdownCodec, mdxCodec } from "./index.js";

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
