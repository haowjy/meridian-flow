/** Every link the Meridian Markdown card shows the model must parse as a link. */
import { documentComponentRegistry, mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";

import { DOCUMENT_DIALECT_CORE_INSTRUCTION } from "./document-dialect.js";

const codec = mdxCodec({
  schema: buildDocumentSchema(),
  components: documentComponentRegistry,
  assetPathResolver: unresolvedAssetPathResolver,
});

/** Inline-code examples in the card that spell a Markdown link. */
const linkExamples = [...DOCUMENT_DIALECT_CORE_INSTRUCTION.matchAll(/`([^`]*\]\([^`]*\))`/g)]
  .map((match) => match[1] ?? "")
  .filter((example) => !example.startsWith("!"));

describe("the Meridian Markdown card's link examples", () => {
  it("shows how to link a destination with spaces", () => {
    expect(linkExamples).toContain("[Gate](<The Second Gate.md>)");
  });

  it.each(linkExamples)("parses %s as a link, as the model will write it", (example) => {
    const paragraph = codec.parse(example).blocks[0];
    const href = paragraph?.firstChild?.marks.find((mark) => mark.type.name === "link")?.attrs.href;
    expect(href).toBeTruthy();
    expect(paragraph?.textContent).not.toContain("](");
  });

  it("keeps a destination with spaces as text when it is not wrapped", () => {
    const paragraph = codec.parse("[Gate](The Second Gate.md)").blocks[0];
    expect(paragraph?.firstChild?.marks).toEqual([]);
  });
});
