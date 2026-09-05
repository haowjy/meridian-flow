import type { CatalogEntry, CatalogScope } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { catalogViewFromSnapshot } from "@/client/query/context-catalog-cache";
import { projectCatalogView } from "@/client/query/useContextCatalog";
import { catalogFileSuggestions } from "./file-suggestions";

const scope = { kind: "project", projectId: "project-1" } as const satisfies CatalogScope;
const entries: CatalogEntry[] = [
  {
    kind: "source",
    entryId: "source-1",
    scope,
    scheme: "manuscript",
    name: "Manuscript",
    uri: "manuscript://",
  },
  {
    kind: "file",
    entryId: "document-1",
    scope,
    sourceId: "source-1",
    parentId: "source-1",
    name: "Chapter.md",
    aliases: [],
    path: ["Chapter.md"],
    uri: "manuscript://Chapter.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    provisionalName: false,
  },
  {
    kind: "file",
    entryId: "document-binary",
    scope,
    sourceId: "source-1",
    parentId: "source-1",
    name: "archive.txt",
    aliases: [],
    path: ["archive.txt"],
    uri: "manuscript://archive.txt",
    editable: false,
    disposition: "binary",
    fileType: "binary",
    mimeType: "application/octet-stream",
    provisionalName: false,
  },
];

describe("catalog projections", () => {
  it("projects tree and picker from the same normalized identity", () => {
    const view = catalogViewFromSnapshot({
      scope,
      generation: "generation-1",
      headRevision: "0",
      cursor: "cursor-0",
      entries,
    });
    const catalog = projectCatalogView(scope.projectId, "manuscript", view);
    const picker = catalogFileSuggestions([view]);
    expect(catalog.findDocument("document-1")).toMatchObject({
      documentId: "document-1",
      path: "/Chapter.md",
    });
    expect(catalog.findDocument("document-binary")).toMatchObject({
      editable: false,
      fileType: "binary",
      mimeType: "application/octet-stream",
    });
    expect(picker).toContainEqual(
      expect.objectContaining({ scheme: "manuscript", path: "/Chapter.md", kind: "file" }),
    );
    expect(view.entries.get("document-1")).toBe(entries[1]);
  });
});
