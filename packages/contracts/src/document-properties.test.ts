/** Lossless frontmatter accepts only the shared stored shape, not arbitrary metadata. */
import { expect, it } from "vitest";
import { readStoredDocumentProperties } from "./document-properties.js";

it("returns the stored YAML object unchanged and rejects nonexact shapes", () => {
  const properties = { format: "yaml" as const, text: "# formatting\naliases: [Gate]\n" };
  expect(readStoredDocumentProperties({ properties })).toBe(properties);
  for (const metadata of [
    null,
    [],
    {},
    { properties: [] },
    { properties: { format: "json", text: "{}" } },
    { properties: { format: "yaml", text: 1 } },
    { properties: { ...properties, extra: true } },
    { properties: Object.assign(Object.create(properties), { one: 1, two: 2 }) },
  ]) {
    expect(readStoredDocumentProperties(metadata)).toBeNull();
  }
});
