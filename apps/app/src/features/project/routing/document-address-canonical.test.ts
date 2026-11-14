/** Hidden reviews repair canonical locators while retaining their selected Work and draft. */
import type { CatalogFileEntry } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { canonicalDocumentAddress } from "./document-address-canonical";
import type { ProjectAddress } from "./project-address";

it("follows a reviewed identity through a rename or cross-source move", () => {
  const address = {
    projectId: "project",
    destination: { kind: "document", scheme: "kb", path: "Withern" },
    work: { kind: "id", id: "00000000-0000-4000-8000-000000000001" },
    itemKey: "draft",
  } as ProjectAddress;
  const document = {
    kind: "file",
    entryId: "hidden",
    sourceId: "source",
    parentId: "folder",
    name: "Withern",
    aliases: [],
    provisionalName: false,
    extension: "",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    uri: "unfiled://Moved/Withern",
    path: ["Moved", "Withern"],
    scope: { kind: "project", projectId: "project" },
  } as CatalogFileEntry;
  expect(canonicalDocumentAddress(address, document)).toEqual({
    ...address,
    destination: { kind: "document", scheme: "unfiled", path: "Moved/Withern" },
  });
});
