// Hard breaks round-trip in both dialects, including where Markdown has no `\` spelling.
import { describe, expect, it } from "vitest";
import { docFrom, paragraph, schema, t } from "./codec-test-support.js";
import { markdownCodec, mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "./index.js";

const hardBreak = () => schema.node("hard_break");
const codecs = [
  {
    dialect: "Markdown",
    codec: markdownCodec({ schema }),
  },
  { dialect: "MDX", codec: mdxCodec({ schema }) },
];
const cases = [
  { name: "a break between words", blocks: [paragraph(t("one"), hardBreak(), t("two"))] },
  { name: "a break ending a paragraph", blocks: [paragraph(t("one"), hardBreak())] },
  {
    name: "two breaks ending a paragraph",
    blocks: [paragraph(t("one"), hardBreak(), hardBreak())],
  },
  { name: "a paragraph of one break", blocks: [paragraph(hardBreak())] },
  {
    name: "a paragraph of two breaks between others",
    blocks: [paragraph(t("before")), paragraph(hardBreak(), hardBreak()), paragraph(t("after"))],
  },
];

describe.each(codecs)("$dialect hard breaks", ({ codec }) => {
  it.each(cases)("round-trips $name", ({ blocks }) => {
    const wire = codec.serialize(blocks, UNSCOPED_DOCUMENT_LINKS);

    expect(docFrom(codec.parse(wire).blocks).toJSON()).toEqual(docFrom(blocks).toJSON());
  });
});
