import { describe, expect, it } from "vitest";
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import { viewerTabForCatalogFile } from "@/client/stores";

function file(overrides: Partial<CatalogFile> = {}) {
  return {
    kind: "file",
    entryId: "entry-1",
    parentId: "root",
    documentId: "document-1",
    name: "map.png",
    path: "map.png",
    uri: "uploads://@work/map.png",
    provisionalName: false,
    editable: false,
    disposition: "binary",
    fileType: "image",
    mimeType: "image/png",
    ...overrides,
  } as CatalogFile;
}

describe("viewerTabForCatalogFile", () => {
  it("preserves Scratch's read-only Markdown viewer metadata", () => {
    const tab = viewerTabForCatalogFile(
      file({ name: "notes.md", path: "notes.md" }),
      "scratch",
      "work-1",
    );
    expect(tab).toMatchObject({
      kind: "viewer",
      editable: false,
      fileType: "binary",
      mimeType: "text/markdown",
      workId: "work-1",
    });
  });

  it("uses the same upload classification for editable and binary catalog files", () => {
    const image = viewerTabForCatalogFile(file(), "uploads", "work-1");
    const editable = viewerTabForCatalogFile(
      file({
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      } as Partial<CatalogFile>),
      "uploads",
      "work-1",
    );
    expect(image).toMatchObject({ fileType: "image", mimeType: "image/png" });
    expect(editable).toMatchObject({ fileType: "binary" });
    expect(editable.mimeType).toBeUndefined();
  });
});
