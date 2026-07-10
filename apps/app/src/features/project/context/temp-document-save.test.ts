import type { ProjectContextTreeDirectory } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { decideTempDocumentSaveTarget } from "./temp-document-save";

const tree: ProjectContextTreeDirectory = {
  kind: "dir",
  name: "Manuscript",
  path: "/",
  uri: "manuscript://",
  children: [
    {
      kind: "file",
      name: "chapter.md",
      path: "/chapter.md",
      uri: "manuscript://chapter.md",
      documentId: "chapter",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    },
  ],
};

describe("decideTempDocumentSaveTarget", () => {
  it("blocks an existing save target rather than allowing overwrite", () => {
    expect(decideTempDocumentSaveTarget(tree, "/chapter.md")).toMatchObject({
      outcome: "blocked",
      existing: { documentId: "chapter" },
    });
  });

  it("allows a name absent from the fresh tree", () => {
    expect(decideTempDocumentSaveTarget(tree, "/new-chapter.md")).toEqual({
      outcome: "available",
    });
  });
});
