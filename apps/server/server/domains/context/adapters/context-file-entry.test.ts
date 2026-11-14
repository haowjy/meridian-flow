/** A file entry grows exactly one boolean for properties; their content never rides along. */
import { describe, expect, it } from "vitest";
import { type CatalogFileRow, mapAuthoritativeFile } from "./context-file-entry.js";

const entryFor = (metadata: unknown) =>
  mapAuthoritativeFile({
    document: {
      id: "d1",
      contextSourceId: "s1",
      folderId: null,
      name: "Chapter 1",
      fileType: "markdown",
      storageUrl: null,
      mimeType: null,
      metadata,
    } as CatalogFileRow,
    scope: { kind: "project", projectId: "p1" } as never,
    scheme: "manuscript",
    workId: null,
    workHandle: null,
    parentPath: [],
  });

describe("file entry hasProperties", () => {
  it("is true only for stored properties with something in them", () => {
    const text = "status: revised\n";
    expect(entryFor({ properties: { format: "yaml", text } }).hasProperties).toBe(true);
    expect(entryFor({ properties: { format: "yaml", text: " \n" } }).hasProperties).toBe(false);
    expect(entryFor({ aliases: ["Gate"] }).hasProperties).toBe(false);
    expect(entryFor(null).hasProperties).toBe(false);
  });

  it("does not carry the properties themselves", () => {
    const entry = entryFor({ properties: { format: "yaml", text: "status: revised\n" } });
    expect(JSON.stringify(entry)).not.toContain("revised");
  });
});
