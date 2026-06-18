/**
 * Verifies first-row-header tables round-trip losslessly through the MDX bridge.
 * Complements mdx-bridge.test.ts normalization cases — valid editor/schema shapes
 * must not mutate on docToMdx → mdxToDoc.
 */
import { describe, expect, it } from "vitest";

import { docToMdx, documentMdxSchema, mdxToDoc } from "./mdx-bridge.js";

const schema = documentMdxSchema();

function t(text: string) {
  return schema.text(text);
}

describe("first-row-header table MDX round-trip", () => {
  it("losslessly round-trips a valid first-row-header table", () => {
    const doc = schema.node("doc", null, [
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
    ]);

    expect(mdxToDoc(docToMdx(doc)).eq(doc)).toBe(true);
  });

  it("cannot construct a mixed header/body row in the schema", () => {
    expect(() =>
      schema.node("table_row", null, [
        schema.node("table_header", null, [t("A")]),
        schema.node("table_cell", null, [t("B")]),
      ]),
    ).toThrow();
  });
});
