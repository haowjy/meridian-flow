/** Stored properties accept exactly the public YAML envelope, not arbitrary metadata. */
import { expect, it } from "vitest";
import { readStoredDocumentProperties } from "./document-properties.js";

it("returns the exact valid stored envelope", () => {
  const properties = { format: "yaml", text: "aliases: [Gate]\n" };
  expect(readStoredDocumentProperties({ properties })).toBe(properties);
});
it.each([
  null,
  undefined,
  [],
  {},
  { properties: null },
  { properties: [] },
  { properties: { format: "yaml", text: 1 } },
  { properties: { format: "json", text: "{}" } },
  { properties: { format: "yaml", text: "", extra: true } },
  { properties: Object.assign(Object.create({ format: "yaml", text: "" }), { a: 1, b: 2 }) },
])("rejects invalid metadata %#", (metadata) => {
  expect(readStoredDocumentProperties(metadata)).toBeNull();
});
